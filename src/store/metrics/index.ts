import type { Store } from '../db.js';
import {
  cycleTime,
  escapedDefects,
  firstPassRate,
  mergeFriction,
  shipFailures,
  type CycleTime,
  type EscapedDefects,
  type FirstPassRate,
  type MergeFriction,
  type ShipFailures,
} from './delivery.js';
import {
  findingDensity,
  findingSourceSplit,
  gateKillDistribution,
  interruptions,
  reworkLoops,
  type FindingDensity,
  type FindingSourceSplit,
  type GateKillDistribution,
  type Interruptions,
  type ReworkLoops,
} from './quality.js';
import {
  agentActiveTime,
  graphEfficiency,
  tokenBurn,
  type AgentActiveTime,
  type GraphEfficiency,
  type TokenBurn,
} from './cost.js';
import type { MetricsScope } from './scope.js';

export type { MetricsScope } from './scope.js';

/**
 * The effectiveness metric set — every number `karst stats` reports, collected
 * in one read-only pass over the registry.
 *
 * SWE-bench measures the model, not the harness. What the harness can be judged
 * on is its own telemetry: how often a stage passed first time, how much rework
 * it cost, what the gates killed, what a human still had to catch, and what all
 * of that spent. Everything here is already recorded — nothing is derived from
 * a column that does not exist (see `UNAVAILABLE_METRICS`).
 */
export interface EffectivenessMetrics {
  readonly scope: {
    readonly projectSlug: string | null;
    readonly projectId: number | null;
    readonly since: string | null;
  };
  readonly firstPass: FirstPassRate;
  readonly rework: ReworkLoops;
  readonly gates: GateKillDistribution;
  readonly cycleTime: CycleTime;
  readonly agentActiveTime: AgentActiveTime;
  readonly tokens: TokenBurn;
  readonly escapedDefects: EscapedDefects;
  readonly findings: FindingDensity;
  readonly findingSource: FindingSourceSplit;
  readonly mergeFriction: MergeFriction;
  readonly shipFailures: ShipFailures;
  readonly graph: GraphEfficiency;
  readonly interruptions: Interruptions;
  readonly unavailable: readonly UnavailableMetric[];
}

export interface UnavailableMetric {
  readonly metric: string;
  /** Why it cannot be computed — the missing column, named exactly. */
  readonly reason: string;
}

/**
 * Metrics the current schema CANNOT answer. They are reported as unavailable,
 * with the missing column named, and are never approximated: a fabricated
 * number here would be worse than the silence it replaced.
 */
export const UNAVAILABLE_METRICS: readonly UnavailableMetric[] = [
  {
    metric: 'human intervention count',
    reason:
      'nothing counts unblocks or resumes — `stages.blocked_*` records that a block exists and `tickets.paused_at` only the current pause. Needs a `human_actions` table.',
  },
  {
    metric: 'ticket-level merge stamp',
    reason:
      '`prs.merged_at` is per repo; "ticket merged" as max() across selected repos is derivable but fragile. Needs a `tickets.merged_at` column.',
  },
  {
    metric: 'gate flake rate',
    reason:
      '`gate_runs` carries no `head_sha`, so the same gate on the same commit returning a different exit code is undetectable.',
  },
  {
    metric: 'waiting-on-human wall clock',
    reason: '`stages.blocked_at` has no matching `unblocked_at`.',
  },
] as const;

/** Run every metric query for one scope. Read-only: no statement here writes. */
export function collectMetrics(
  store: Store,
  scope: MetricsScope & { readonly projectSlug?: string },
): EffectivenessMetrics {
  return {
    scope: {
      projectSlug: scope.projectSlug ?? null,
      projectId: scope.projectId ?? null,
      since: scope.since ?? null,
    },
    firstPass: firstPassRate(store, scope),
    rework: reworkLoops(store, scope),
    gates: gateKillDistribution(store, scope),
    cycleTime: cycleTime(store, scope),
    agentActiveTime: agentActiveTime(store, scope),
    tokens: tokenBurn(store, scope),
    escapedDefects: escapedDefects(store, scope),
    findings: findingDensity(store, scope),
    findingSource: findingSourceSplit(store, scope),
    mergeFriction: mergeFriction(store, scope),
    shipFailures: shipFailures(store, scope),
    graph: graphEfficiency(store, scope),
    interruptions: interruptions(store, scope),
    unavailable: UNAVAILABLE_METRICS,
  };
}
