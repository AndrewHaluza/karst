/**
 * Host reader for the ticket's auto-fix state (T1004). It turns autopilot store rows into the
 * `AutofixFacts` the pure wording module reads (`model/inside/autofix.ts`). It writes nothing.
 * The CI "running" state has no store signal yet, so only a conflict round shows as running.
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

function resolveTarget(store: Store, ticketId: number, config: AutopilotConfig | undefined): AutofixTarget | null {
  for (const { repo, kind } of listAutopilotBudgets(store, ticketId)) {
    const b = getAutopilotBudget(store, ticketId, repo, kind);
    if (b.attempts < maxFor(kind, config) + b.extra) continue;
    const pr = store.db.prepare('SELECT repo, number, checks FROM prs WHERE ticket_id = ? AND repo = ?').get(ticketId, repo) as PrRow | undefined;
    const failing = kind === 'ci' ? parseChecks(pr?.checks)?.failing[0] : undefined;
    const logUrl = safeUrl(failing?.url);
    return { kind, repo, pr: pr?.number ?? null, check: failing?.name ?? null, ...(logUrl ? { logUrl } : {}) };
  }
  return null;
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
  const spent = reason !== null && reason.startsWith('auto-fix stopped');
  const target = spent ? resolveTarget(store, ticketId, config) : null;
  const facts: AutofixFacts = {
    override: ticket.mode,
    projectDefault,
    effective,
    reason,
    round: resolveRound(store, ticketId, config),
    stopAfter: ticket.stopAfter,
    unknownCi: [],
    target,
  };
  return {
    slice: { override: ticket.mode, projectDefault, effective, banner: autofixBanner(facts), log: readLog(store, ticketId) },
    row: autofixRow(facts),
  };
}
