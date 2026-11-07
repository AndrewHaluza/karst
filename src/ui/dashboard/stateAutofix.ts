/**
 * Host reader for the ticket's auto-fix state (T1004). It turns autopilot store rows into the
 * `AutofixFacts` the pure wording module reads (`model/inside/autofix.ts`). It writes nothing.
 * The CI "running" state has no store signal yet, so only a conflict round shows as running.
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

export const AUTOFIX_LOG_LIMIT = 5;
const NOTE_PREFIX = 'Autopilot:';

export interface AutopilotSlice {
  readonly override: 'inherit' | 'on' | 'off';
  readonly projectDefault: boolean;
  readonly effective: boolean;
  readonly banner: AutofixBannerView | null;
  readonly log: readonly string[];
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

function resolveRound(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixFacts['round'] {
  if (getConflictRoundAt(store, ticketId) === null) return null;
  const entry = listAutopilotBudgets(store, ticketId).find((b) => b.kind === 'conflicts');
  if (!entry) return null;
  const budget = getAutopilotBudget(store, ticketId, entry.repo, 'conflicts');
  const pr = store.db.prepare('SELECT number FROM prs WHERE ticket_id = ? AND repo = ?').get(ticketId, entry.repo) as { number: number | null } | undefined;
  return { kind: 'conflicts', repo: entry.repo, pr: pr?.number ?? null, check: null, used: budget.attempts, max: maxFor('conflicts', config) + budget.extra, step: 0 };
}

export function readAutofix(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixReading {
  const ticket = getAutopilotTicket(store, ticketId);
  const projectDefault = config?.enabled === true;
  const effective = effectiveAutopilot(store, ticketId, projectDefault);
  const block = stageBlock(store, ticketId, 'ship')?.reason ?? null;
  const reason = [block, ticket.stoppedReason, ticket.pausedReason].find((r) => typeof r === 'string' && r.startsWith('auto-fix')) ?? null;
  const kind = reason === null ? null : parkedKind(reason);
  const target = kind === null ? null : resolveTarget(store, ticketId, config, kind);
  const facts: AutofixFacts = {
    override: ticket.mode,
    projectDefault,
    effective,
    reason,
    round: resolveRound(store, ticketId, config),
    stopAfter: ticket.stopAfter,
    unknownCi: unknownCiLabels(store, ticketId),
    target,
  };
  return {
    slice: { override: ticket.mode, projectDefault, effective, banner: autofixBanner(facts), log: readLog(store, ticketId) },
    row: autofixRow(facts),
  };
}
