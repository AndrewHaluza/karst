import type { StageKey } from '../model/types.js';

/**
 * The stage graph (§11) — a graph, not a line. Edges are keyed by the *verdict
 * kind* at a stage, so a single stage can branch (uat/review fork on pass vs
 * fail). `null` verdicts have no edge here by design — the no-inference
 * guarantee (§5.4) lives in the machine, which refuses to transition without a
 * definite verdict.
 *
 * Shape (fix→revalidate→review loop, plan §T4.1):
 *   scope ─pass→ impl ─pass→ uat ─pass→ review ─pass→ ship ─pass→ done
 *                              │                 │        ▲
 *                            fail              fail       │
 *                              ▼                 ▼         │
 *                             fix ──────────── fix ─pass──┘
 *
 * `fix` re-runs and, on pass, re-enters `review` (revalidate) — the deterministic
 * MVP loop. A gate can fail more than once; `attempt` climbs per loop (machine).
 */

/** A verdict-keyed edge set for one stage. `undefined` = terminal on that kind. */
export interface StageEdges {
  passed?: StageKey;
  failed?: StageKey;
}

/** The static transition table. */
export const STAGE_GRAPH: Readonly<Record<StageKey, StageEdges>> = {
  scope: { passed: 'impl' },
  impl: { passed: 'uat' },
  uat: { passed: 'review', failed: 'fix' },
  review: { passed: 'ship', failed: 'fix' },
  fix: { passed: 'review' }, // revalidate: fix pass re-enters the review gate
  ship: { passed: 'done' },
  done: {},
};

/**
 * True when a stage has no outgoing edge at all — the graph's exit. Nothing runs
 * there and no verdict can ever follow, so arriving at one IS completing it
 * (machine.ts). Derived from the table rather than naming `done`, so a second
 * terminal never has to be remembered here.
 */
export function isTerminal(stage: StageKey): boolean {
  const edges = STAGE_GRAPH[stage];
  return edges.passed === undefined && edges.failed === undefined;
}

/** Stages whose `failed` verdict routes to the fix loop. */
export const GATE_STAGES: readonly StageKey[] = ['uat', 'review'] as const;

/** True when a stage sends a failed ticket into `fix`. */
export function isGate(stage: StageKey): boolean {
  return GATE_STAGES.includes(stage);
}
