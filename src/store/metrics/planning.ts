import type { Store } from '../db.js';
import { agentActiveTime, tokenBurn } from './cost.js';
import { firstPassRate } from './delivery.js';
import { findingDensity, gateKillDistribution, reworkLoops } from './quality.js';
import { percentile, ratio, scopeSql, type MetricsScope } from './scope.js';

/**
 * Planning-draft metrics: how drafts turn out once they become tickets.
 *
 * Observational and read-only (@arch:CLI-07). Drafts are compared with drafts
 * only. Every outcome number comes from the existing metric families, scoped to
 * the draft-born ticket set via `MetricsScope.ticketIds`; a missing source is
 * `null` (rendered `pending`), never 0 (@arch:PM-00). Draft text is never
 * returned except a proposal title in the stuck list.
 */

/** A split bucket with fewer drafts than this is flagged LOW. */
export const LOW_SAMPLE_THRESHOLD = 10;

const DONE_STAGES: readonly string[] = ['done', 'closed'];
const MS_PER_HOUR = 3_600_000;

export interface FunnelCounts {
  readonly pending: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly total: number;
}

export interface PlanningOutcome {
  /** Draft-born tickets (accepted proposals whose ticket row still exists). */
  readonly tickets: number;
  readonly merged: number;
  readonly mergedRate: number | null;
  readonly medianHoursToMerge: number | null;
  readonly firstPassRate: number | null;
  readonly reworkRounds: number | null;
  readonly reviewFindings: number | null;
  readonly fixRounds: number | null;
  readonly gateKills: number | null;
  readonly reportedTokens: number | null;
  readonly estimatedTokens: number | null;
  readonly agentActiveHours: number | null;
}

export interface SplitBucket {
  readonly bucket: string;
  readonly drafts: number;
  readonly low: boolean;
  readonly outcome: PlanningOutcome;
}

export interface PlanningSplit {
  readonly name: string;
  readonly buckets: readonly SplitBucket[];
}

export interface StuckDraft {
  readonly proposalId: number;
  readonly ticketId: number;
  readonly title: string;
  readonly stage: string | null;
  readonly ageHours: number | null;
}

export interface PlanningReport {
  readonly scope: { readonly projectId: number | null; readonly since: string | null };
  readonly funnel: {
    readonly total: FunnelCounts;
    readonly bySession: readonly (FunnelCounts & {
      readonly sessionId: number;
      readonly core: string;
      readonly model: string | null;
    })[];
    /** Revise and accept both bump `updated_at`, so the two cannot be told apart. */
    readonly revisedBeforeAccept: { readonly value: null; readonly missing: string };
  };
  readonly outcome: PlanningOutcome;
  readonly splits: readonly PlanningSplit[];
  readonly stuck: readonly StuckDraft[];
}

interface DraftRow {
  id: number;
  session_id: number;
  core: string;
  model: string | null;
  status: 'pending' | 'accepted' | 'discarded';
  ticket_id: number | null;
  created_at: string;
  payload_json: string;
  depends_on: string;
  stage_current: string | null;
  ticket_exists: number | null;
  archived_at: string | null;
}

interface Traits {
  readonly constraints: number | null;
  readonly summaryLength: number | null;
  readonly repos: number | null;
  readonly hasDependsOn: boolean | null;
}

/** SQLite `datetime('now')` is UTC with no zone marker; make that explicit. */
function parseStamp(value: string): number {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

/** Trait read from the stored JSON; an unreadable field yields `null`, never a guess. */
function readTraits(row: DraftRow): Traits {
  let payload: unknown = null;
  let depends: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    // unreadable payload: every payload trait stays null and lands in the 'unreadable' bucket
  }
  try {
    depends = JSON.parse(row.depends_on);
  } catch {
    // unreadable depends_on: hasDependsOn stays null
  }
  const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const summary = p['summary'];
  return {
    constraints: payload === null ? null : (arrayLength(p['constraints']) ?? 0),
    summaryLength: typeof summary === 'string' ? summary.length : null,
    repos: arrayLength(p['repos']),
    hasDependsOn: depends === null ? null : arrayLength(depends) !== null && arrayLength(depends)! > 0,
  };
}

function title(row: DraftRow): string {
  try {
    const t = (JSON.parse(row.payload_json) as { title?: unknown }).title;
    return typeof t === 'string' ? t : '(untitled)';
  } catch {
    return '(unreadable)';
  }
}

function funnelCounts(rows: readonly DraftRow[]): FunnelCounts {
  const count = (status: DraftRow['status']): number => rows.filter((r) => r.status === status).length;
  return {
    pending: count('pending'),
    accepted: count('accepted'),
    discarded: count('discarded'),
    total: rows.length,
  };
}

function mergedAt(store: Store, ticketIds: readonly number[]): Map<number, number> {
  const { clause, params } = scopeSql({ ticketIds }, { projectColumn: 't.project_id' });
  const rows = store.db
    .prepare(
      `SELECT t.id AS id, MAX(p.merged_at) AS merged_at
         FROM tickets t
         JOIN prs p ON p.ticket_id = t.id
        WHERE p.merged_at IS NOT NULL${clause}
        GROUP BY t.id`,
    )
    .all(...params) as { id: number; merged_at: string }[];
  return new Map(rows.map((r) => [r.id, parseStamp(r.merged_at)]));
}

/** Outcome of one set of drafts (each carries a ticket id), via the shared metric queries. */
function outcomeFor(store: Store, drafts: readonly DraftRow[]): PlanningOutcome {
  const ticketIds = drafts.map((d) => d.ticket_id!);
  const scope: MetricsScope = { ticketIds };
  const merged = mergedAt(store, ticketIds);
  const hours = drafts
    .map((d) => {
      const at = merged.get(d.ticket_id!);
      return at === undefined ? NaN : (at - parseStamp(d.created_at)) / MS_PER_HOUR;
    })
    .filter((h) => Number.isFinite(h));

  const firstPass = firstPassRate(store, scope);
  const stageRuns = firstPass.overall.advanced + firstPass.overall.blocked + firstPass.overall.stopped;
  const fixRuns = firstPass.byStage
    .filter((s) => s.stageKey === 'fix')
    .reduce((sum, s) => sum + s.advanced + s.blocked + s.stopped, 0);
  const rework = reworkLoops(store, scope);
  const gates = gateKillDistribution(store, scope);
  const tokens = tokenBurn(store, scope);
  const active = agentActiveTime(store, scope);
  const findings = findingDensity(store, scope);
  const hasActive = active.processRunHours + active.implementationRunHours > 0 || active.openRuns > 0;
  const ran = stageRuns > 0;

  return {
    tickets: ticketIds.length,
    merged: merged.size,
    mergedRate: ratio(merged.size, ticketIds.length),
    medianHoursToMerge: percentile(hours, 0.5),
    firstPassRate: firstPass.overall.rate,
    reworkRounds: ran ? rework.rounds : null,
    reviewFindings: ran ? findings.review.total : null,
    fixRounds: ran ? fixRuns : null,
    gateKills: gates.runs > 0 ? gates.failed : null,
    reportedTokens: tokens.calls > 0 ? tokens.reportedTokens : null,
    estimatedTokens: tokens.calls > 0 ? tokens.estimatedTokens : null,
    agentActiveHours: hasActive ? active.processRunHours + active.implementationRunHours : null,
  };
}

function bucketize(
  store: Store,
  name: string,
  drafts: readonly DraftRow[],
  keyOf: (row: DraftRow) => string,
): PlanningSplit {
  const groups = new Map<string, DraftRow[]>();
  for (const d of drafts) {
    const key = keyOf(d);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const buckets = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([bucket, rows]) => ({
      bucket,
      drafts: rows.length,
      low: rows.length < LOW_SAMPLE_THRESHOLD,
      outcome: outcomeFor(store, rows),
    }));
  return { name, buckets };
}

const UNREADABLE = 'unreadable';

function constraintBucket(n: number | null): string {
  if (n === null) return UNREADABLE;
  if (n === 0) return '0';
  return n <= 5 ? '1-5' : '6+';
}

function reposBucket(n: number | null): string {
  if (n === null) return UNREADABLE;
  return n >= 3 ? '3+' : String(n);
}

/** Tertile labels by summary length; cut points come from the drafts being split. */
function summaryBucketer(lengths: readonly number[]): (n: number | null) => string {
  const low = percentile(lengths, 1 / 3);
  const high = percentile(lengths, 2 / 3);
  return (n) => {
    if (n === null || low === null || high === null) return UNREADABLE;
    if (n <= low) return `short (<=${Math.floor(low)} chars)`;
    if (n <= high) return `mid (<=${Math.floor(high)} chars)`;
    return `long (>${Math.floor(high)} chars)`;
  };
}

function buildSplits(store: Store, drafts: readonly DraftRow[]): PlanningSplit[] {
  const traits = new Map(drafts.map((d) => [d.id, readTraits(d)] as const));
  const trait = (d: DraftRow): Traits => traits.get(d.id)!;
  const lengths = drafts.flatMap((d) => trait(d).summaryLength ?? []);
  const summary = summaryBucketer(lengths);
  return [
    bucketize(store, 'core/model', drafts, (d) => `${d.core}/${d.model ?? 'unknown'}`),
    bucketize(store, 'constraints', drafts, (d) => constraintBucket(trait(d).constraints)),
    bucketize(store, 'dependsOn', drafts, (d) => {
      const has = trait(d).hasDependsOn;
      return has === null ? UNREADABLE : has ? 'has dependsOn' : 'no dependsOn';
    }),
    bucketize(store, 'summary length', drafts, (d) => summary(trait(d).summaryLength)),
    bucketize(store, 'repos', drafts, (d) => reposBucket(trait(d).repos)),
  ];
}

function loadDrafts(store: Store, scope: MetricsScope): DraftRow[] {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 's.project_id',
    sinceColumn: 'pp.created_at',
  });
  return store.db
    .prepare(
      `SELECT pp.id AS id, pp.session_id AS session_id, s.core AS core, s.model AS model,
              pp.status AS status, t.id AS ticket_exists, pp.ticket_id AS ticket_id,
              pp.created_at AS created_at, pp.payload_json AS payload_json,
              pp.depends_on AS depends_on, t.stage_current AS stage_current,
              t.archived_at AS archived_at
         FROM planning_proposals pp
         JOIN planning_sessions s ON s.id = pp.session_id
         LEFT JOIN tickets t ON t.id = pp.ticket_id
        WHERE 1 = 1${clause}
        ORDER BY pp.id`,
    )
    .all(...params) as DraftRow[];
}

/** Collect the planning report. `now` is injected so the stuck ages are testable. */
export function collectPlanning(
  store: Store,
  scope: Pick<MetricsScope, 'projectId' | 'since'>,
  now: Date,
): PlanningReport {
  const rows = loadDrafts(store, scope);
  const born = rows.filter((r) => r.status === 'accepted' && r.ticket_exists !== null);

  const sessions = new Map<number, DraftRow[]>();
  for (const r of rows) sessions.set(r.session_id, [...(sessions.get(r.session_id) ?? []), r]);

  const stuck = born
    .filter((r) => r.archived_at === null && !DONE_STAGES.includes(r.stage_current ?? ''))
    .map((r) => {
      const created = parseStamp(r.created_at);
      return {
        proposalId: r.id,
        ticketId: r.ticket_id!,
        title: title(r),
        stage: r.stage_current,
        ageHours: Number.isFinite(created) ? (now.getTime() - created) / MS_PER_HOUR : null,
      };
    });

  return {
    scope: { projectId: scope.projectId ?? null, since: scope.since ?? null },
    funnel: {
      total: funnelCounts(rows),
      bySession: [...sessions.entries()].map(([sessionId, rs]) => ({
        sessionId,
        core: rs[0]!.core,
        model: rs[0]!.model,
        ...funnelCounts(rs),
      })),
      revisedBeforeAccept: {
        value: null,
        missing:
          'planning_proposals has no revision stamp or counter (`updated_at` is also bumped by accept); needs a `revised_at` or `revision_count` column',
      },
    },
    outcome: outcomeFor(store, born),
    splits: buildSplits(store, born),
    stuck,
  };
}
