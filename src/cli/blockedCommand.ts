import type { Store } from '../store/db.js';
import { reviewStallAttempts } from '../workflow/reviewStallRead.js';

/**
 * `karst blocked [--kind <kind>] [--json]` — one row per open ticket with a
 * stage block, plus a summary of block counts per kind.
 *
 * READ-ONLY: it issues SELECTs only, so a planning session may run it through
 * `KARST_DB_READONLY` (@arch:CLI-13). Block history is NOT stored — a block is
 * cleared when it resolves (`stages.blocked_*` has no `unblocked_at`, see the
 * `unmeasurable` list in `store/metrics/index.ts`). So the "before" count is
 * the blocks that BEGAN in the 14 days before `now` and are still stored,
 * including ones on tickets since archived or done. It is a floor, not a total.
 */

export const BASELINE_WINDOW_DAYS = 14;
/** Severity floor for the review-stalled findings: the review gate's default. */
const STALL_FINDING_FLOOR = 'high' as const;
const DAY_MS = 86_400_000;

export interface ParsedBlocked {
  readonly kind?: string;
  readonly json: boolean;
}

export interface BlockedRound {
  readonly attempt: number;
  readonly findings: readonly string[];
}

export interface BlockedRow {
  readonly key: string;
  readonly stage: string;
  readonly kind: string;
  readonly since: string;
  readonly reason: string;
  readonly agentState: string | null;
  /** Present only for `review-stalled`: the blocking findings per review round. */
  readonly rounds?: readonly BlockedRound[];
}

export interface BlockedCount {
  readonly kind: string;
  /** Open blocks now. */
  readonly now: number;
  /** Blocks that began in the 14 days before now (still stored). */
  readonly before: number;
}

export interface BlockedReport {
  readonly rows: readonly BlockedRow[];
  readonly summary: readonly BlockedCount[];
}

export interface BlockedScope {
  /** `KARST_PROJECT`: restrict to one project id. Absent = every project. */
  readonly projectId?: number;
  readonly now?: () => Date;
}

const KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function parseBlockedArgs(argv: string[]): ParsedBlocked {
  const [cmd, ...rest] = argv;
  if (cmd !== 'blocked') throw new Error(`expected 'blocked' command, got '${cmd ?? ''}'`);
  let kind: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json') json = true;
    else if (flag === '--kind') {
      const v = rest[++i];
      if (v === undefined || !KIND_RE.test(v)) throw new Error('--kind needs a block kind such as review-stalled');
      kind = v;
    } else throw new Error(`unknown flag '${flag}' (want --kind <kind> or --json)`);
  }
  return { json, ...(kind === undefined ? {} : { kind }) };
}

interface BlockRow {
  id: number;
  key: string | null;
  stage_key: string;
  blocked_kind: string;
  blocked_reason: string | null;
  blocked_at: string | null;
  agent_state: string | null;
}

function roundsFor(store: Store, ticketId: number): BlockedRound[] {
  return reviewStallAttempts(store, ticketId, STALL_FINDING_FLOOR).map((a) => ({
    attempt: a.attempt,
    findings: a.findings.map((f) => (f.file === null ? '(no file)' : f.line == null ? f.file : `${f.file}:${f.line}`)),
  }));
}

export function collectBlocked(store: Store, scope: BlockedScope = {}): BlockedReport {
  const now = (scope.now?.() ?? new Date()).getTime();
  const windowStart = new Date(now - BASELINE_WINDOW_DAYS * DAY_MS).toISOString();
  const projectSql = scope.projectId === undefined ? '' : ' AND t.project_id = ?';
  const projectArgs = scope.projectId === undefined ? [] : [scope.projectId];

  const open = store.db
    .prepare(
      `SELECT t.id AS id, t.key AS key, s.stage_key AS stage_key, s.blocked_kind AS blocked_kind,
              s.blocked_reason AS blocked_reason, s.blocked_at AS blocked_at, t.agent_state AS agent_state
         FROM stages s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.blocked_kind IS NOT NULL AND t.archived_at IS NULL
          AND COALESCE(t.stage_current, '') <> 'done'${projectSql}
        ORDER BY s.blocked_at, t.id`,
    )
    .all(...projectArgs) as BlockRow[];

  const rows: BlockedRow[] = open.map((r) => ({
    key: r.key ?? `#${r.id}`,
    stage: r.stage_key,
    kind: r.blocked_kind,
    since: r.blocked_at ?? '',
    reason: r.blocked_reason ?? '',
    agentState: r.agent_state,
    ...(r.blocked_kind === 'review-stalled' ? { rounds: roundsFor(store, r.id) } : {}),
  }));

  // `blocked_at` is written as an ISO-8601 UTC string, so string order is time order.
  const recent = store.db
    .prepare(
      `SELECT s.blocked_kind AS kind, COUNT(*) AS n
         FROM stages s JOIN tickets t ON t.id = s.ticket_id
        WHERE s.blocked_kind IS NOT NULL AND s.blocked_at >= ? AND s.blocked_at < ?${projectSql}
        GROUP BY s.blocked_kind`,
    )
    .all(windowStart, new Date(now).toISOString(), ...projectArgs) as { kind: string; n: number }[];

  const counts = new Map<string, { now: number; before: number }>();
  const bump = (kind: string, field: 'now' | 'before', n: number): void => {
    const c = counts.get(kind) ?? { now: 0, before: 0 };
    counts.set(kind, { ...c, [field]: c[field] + n });
  };
  for (const r of rows) bump(r.kind, 'now', 1);
  for (const r of recent) bump(r.kind, 'before', r.n);
  const summary = [...counts.entries()]
    .map(([kind, c]) => ({ kind, ...c }))
    .sort((a, b) => b.now - a.now || a.kind.localeCompare(b.kind));
  return { rows, summary };
}

function filterKind(report: BlockedReport, kind: string | undefined): BlockedReport {
  if (kind === undefined) return report;
  return { rows: report.rows.filter((r) => r.kind === kind), summary: report.summary.filter((s) => s.kind === kind) };
}

function summaryLine(summary: readonly BlockedCount[]): string {
  if (summary.length === 0) return 'Blocks by kind: none';
  const parts = summary.map((s) => `${s.kind} ${s.now} now / ${s.before} in the ${BASELINE_WINDOW_DAYS} days before`);
  return `Blocks by kind: ${parts.join('; ')}`;
}

function renderRow(r: BlockedRow): string[] {
  const head = `${r.key}  stage=${r.stage}  kind=${r.kind}  since=${r.since}  agent=${r.agentState ?? 'none'}`;
  const lines = [head, `  reason: ${r.reason.replace(/\s+/g, ' ').trim()}`];
  for (const round of r.rounds ?? []) {
    lines.push(`  round ${round.attempt}: ${round.findings.length === 0 ? 'clean' : round.findings.join(', ')}`);
  }
  return lines;
}

export function runBlockedCommand(store: Store, parsed: ParsedBlocked, scope: BlockedScope = {}): string {
  const report = filterKind(collectBlocked(store, scope), parsed.kind);
  if (parsed.json) return JSON.stringify(report, null, 2);
  const body = report.rows.length === 0 ? ['No open ticket has a block.'] : report.rows.flatMap(renderRow);
  return [...body, '', summaryLine(report.summary)].join('\n');
}
