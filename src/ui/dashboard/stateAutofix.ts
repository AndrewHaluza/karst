/**
 * Host reader for the ticket's auto-fix state (T1004). It turns autopilot store rows into the
 * `AutofixFacts` the pure wording module reads (`model/inside/autofix.ts`). It writes nothing.
 * A conflict round shows as running from its arm time. A CI round has no arm marker: it hands the ticket to Implement,
 * so it reads as running while the ticket is out of ship and a CI budget signature still matches the failing checks.
 * An unknown CI status is read from the stored PR rollups with the engine's own rule (@arch:GH-03).
 */
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { DEFAULT_AUTOPILOT_MAX_ATTEMPTS, DEFAULT_AUTOPILOT_MAX_ROUNDS } from '../../manifest/autopilot.js';
import {
  autofixBanner,
  autofixRow,
  type AutofixBannerView,
  type AutofixFacts,
  type AutofixKind,
  type AutofixRowView,
  type AutofixTarget,
} from '../../model/inside/autofix.js';
import { parseChecks } from '../../model/prChecks.js';
import {
  effectiveAutopilot,
  getAutopilotBudget,
  getAutopilotTicket,
  getConflictRoundAt,
  listAutopilotBudgets,
} from '../../store/autopilot.js';
import type { Store } from '../../store/db.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { getTicket } from '../../store/tickets.js';

export const AUTOFIX_LOG_LIMIT = 5;
const NOTE_PREFIX = 'Autopilot:';
/** The note "Stop after this round" posts: the round still runs, so it must not hide the round note. */
const STOP_AFTER_NOTE = 'Autopilot: stopped after this round';

export interface AutopilotSlice {
  readonly override: 'inherit' | 'on' | 'off';
  readonly projectDefault: boolean;
  readonly effective: boolean;
  readonly banner: AutofixBannerView | null;
  readonly log: readonly string[];
  /** An auto-fix round (conflicts or CI) is live: the runtime strip adds "· auto-fix" to the agent state. */
  readonly roundActive: boolean;
}

export interface AutofixReading {
  readonly slice: AutopilotSlice;
  readonly row: AutofixRowView | null;
}

interface PrRow { repo: string; number: number | null; checks: string | null }

function maxFor(kind: AutofixKind, config: AutopilotConfig | undefined): number {
  return kind === 'ci'
    ? (config?.ci.maxAttempts ?? DEFAULT_AUTOPILOT_MAX_ATTEMPTS)
    : (config?.conflicts.maxRounds ?? DEFAULT_AUTOPILOT_MAX_ROUNDS);
}

function readLog(store: Store, ticketId: number): string[] {
  const rows = store.db
    .prepare('SELECT title FROM bulletin_notes WHERE from_ticket_id = ? AND title LIKE ? ORDER BY id DESC LIMIT ?')
    .all(ticketId, `${NOTE_PREFIX}%`, AUTOFIX_LOG_LIMIT) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

/** One line per round the engine armed for the kind, oldest first: the banner's collapsed "Attempt history". */
function readHistory(store: Store, ticketId: number, kind: AutofixKind): string[] {
  const rows = store.db
    .prepare('SELECT title FROM bulletin_notes WHERE from_ticket_id = ? AND title LIKE ? ORDER BY id ASC')
    .all(ticketId, `${NOTE_PREFIX} ${kind} round %/%`) as Array<{ title: string }>;
  return rows.map((r) => r.title.slice(NOTE_PREFIX.length).trim()).filter((t) => /^(conflicts|ci) round \d+\/\d+$/.test(t));
}

/** Only an https log link is kept: the check url is untrusted upstream text. */
function safeUrl(url: string | null | undefined): string | undefined {
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}

const STOPPED_KIND = /^auto-fix stopped: (conflicts|ci) /;

/** The kind a spent park names, or null when the reason has another shape. */
function parkedKind(reason: string): AutofixKind | null {
  const m = STOPPED_KIND.exec(reason);
  return m ? (m[1] as AutofixKind) : null;
}

/**
 * The PR a spent park is about. The kind comes from the park reason, so a spent budget of the other kind never
 * answers for it. A budget that is no longer spent (the limit was raised after the park) still names its repo,
 * and a spent one wins over it.
 */
function resolveTarget(store: Store, ticketId: number, config: AutopilotConfig | undefined, kind: AutofixKind): AutofixTarget | null {
  const repos = listAutopilotBudgets(store, ticketId).filter((b) => b.kind === kind).map((b) => b.repo);
  const isSpent = (repo: string): boolean => {
    const b = getAutopilotBudget(store, ticketId, repo, kind);
    return b.attempts >= maxFor(kind, config) + b.extra;
  };
  const repo = repos.find(isSpent) ?? repos[0];
  if (repo === undefined) return null;
  const pr = store.db.prepare('SELECT repo, number, checks FROM prs WHERE ticket_id = ? AND repo = ?').get(ticketId, repo) as PrRow | undefined;
  const failing = kind === 'ci' ? parseChecks(pr?.checks)?.failing[0] : undefined;
  const logUrl = safeUrl(failing?.url);
  return { kind, repo, pr: pr?.number ?? null, check: failing?.name ?? null, ...(logUrl ? { logUrl } : {}) };
}

/** `repo #n` of every open PR whose CI status is missing, unreadable, unknown or still pending: the engine waits on these. */
function unknownCiLabels(store: Store, ticketId: number): string[] {
  const rows = store.db
    .prepare("SELECT repo, number, checks FROM prs WHERE ticket_id = ? AND status = 'open' AND url IS NOT NULL AND dismissed_at IS NULL ORDER BY repo")
    .all(ticketId) as PrRow[];
  return rows
    .filter((r) => { const c = parseChecks(r.checks); return c === null || c.state === 'unknown' || c.pending > 0; })
    .map((r) => (r.number === null ? r.repo : `${r.repo} #${r.number}`));
}

/**
 * The armed conflict round. The store keeps the arm time but not the repo, so the repo is named only when exactly
 * one conflicts budget exists. With several, the row says no repo rather than a wrong one, and counts the highest used.
 */
function resolveRound(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixFacts['round'] {
  if (getConflictRoundAt(store, ticketId) === null) return null;
  const entries = listAutopilotBudgets(store, ticketId).filter((b) => b.kind === 'conflicts');
  if (entries.length === 0) return null;
  const budgets = entries.map((e) => ({ repo: e.repo, budget: getAutopilotBudget(store, ticketId, e.repo, 'conflicts') }));
  const used = Math.max(...budgets.map((b) => b.budget.attempts));
  const max = maxFor('conflicts', config) + Math.max(...budgets.map((b) => b.budget.extra));
  const only = budgets.length === 1 ? budgets[0]! : null;
  const pr = only ? (store.db.prepare('SELECT number FROM prs WHERE ticket_id = ? AND repo = ?').get(ticketId, only.repo) as { number: number | null } | undefined) : undefined;
  return { kind: 'conflicts', repo: only?.repo ?? '', pr: pr?.number ?? null, check: null, used, max, step: 0 };
}

/**
 * The CI attempt the agent works on. The engine sends the ticket back to Implement and writes no marker, so the round is
 * read from its effects: the ticket is out of ship, no park is on record, and a CI budget with attempts holds the
 * signature of the checks that still fail in the stored rollup. The repo is named only when one budget matches.
 */
function resolveCiRound(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixFacts['round'] {
  if (getTicket(store, ticketId).stageCurrent === 'ship') return null;
  // A manual send-back takes no attempt and posts no note. The engine posts `Autopilot: ci round n/m` when it arms a round; the stop-after note is skipped, as the round still runs.
  const last = store.db.prepare("SELECT title FROM bulletin_notes WHERE from_ticket_id = ? AND title LIKE 'Autopilot:%' AND title <> ? ORDER BY id DESC LIMIT 1").get(ticketId, STOP_AFTER_NOTE) as { title: string } | undefined;
  if (!/^Autopilot: ci round \d+\/\d+$/.test(last?.title ?? '')) return null;
  const hits: Array<{ repo: string; attempts: number; extra: number; number: number | null; check: string | null }> = [];
  for (const e of listAutopilotBudgets(store, ticketId)) {
    if (e.kind !== 'ci') continue;
    const b = getAutopilotBudget(store, ticketId, e.repo, 'ci');
    const pr = store.db.prepare("SELECT repo, number, checks FROM prs WHERE ticket_id = ? AND repo = ? AND status = 'open'").get(ticketId, e.repo) as PrRow | undefined;
    const failing = parseChecks(pr?.checks)?.failing ?? [];
    const signature = [...new Set(failing.map((f) => f.name))].sort().join('\n');
    if (b.attempts > 0 && failing.length > 0 && b.signature === signature) hits.push({ repo: e.repo, attempts: b.attempts, extra: b.extra, number: pr?.number ?? null, check: failing[0]?.name ?? null });
  }
  if (hits.length === 0) return null;
  const only = hits.length === 1 ? hits[0]! : null;
  // The host fetched the log before the hand-off, so the agent is the active step.
  return {
    kind: 'ci', repo: only?.repo ?? '', pr: only?.number ?? null, check: only?.check ?? null,
    used: Math.max(...hits.map((h) => h.attempts)), max: maxFor('ci', config) + Math.max(...hits.map((h) => h.extra)), step: 1,
  };
}

export function readAutofix(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixReading {
  const ticket = getAutopilotTicket(store, ticketId);
  const projectDefault = config?.enabled === true;
  const effective = effectiveAutopilot(store, ticketId, projectDefault);
  const block = stageBlock(store, ticketId, 'ship')?.reason ?? null;
  // `stoppedReason` only remembers the last park note (no repeat note), so it outlives the park: it is not a source here.
  const reason = [block, ticket.pausedReason].find((r) => typeof r === 'string' && r.startsWith('auto-fix')) ?? null;
  const kind = reason === null ? null : parkedKind(reason);
  const target = kind === null ? null : resolveTarget(store, ticketId, config, kind);
  const facts: AutofixFacts = {
    override: ticket.mode,
    projectDefault,
    effective,
    reason,
    round: reason === null ? (resolveRound(store, ticketId, config) ?? resolveCiRound(store, ticketId, config)) : resolveRound(store, ticketId, config),
    stopAfter: ticket.stopAfter,
    unknownCi: unknownCiLabels(store, ticketId),
    target,
    ...(kind === null ? {} : { history: readHistory(store, ticketId, kind) }),
  };
  return {
    slice: { override: ticket.mode, projectDefault, effective, banner: autofixBanner(facts), log: readLog(store, ticketId), roundActive: facts.round !== null },
    row: autofixRow(facts),
  };
}
