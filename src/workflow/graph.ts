import { STAGE_KEYS, type StageKey } from '../model/types.js';

/**
 * The stage graph (§11) — a graph, not a line. Edges are keyed by the *verdict
 * kind* at a stage, so a single stage can branch (uat/review fork on pass vs
 * fail). `null` verdicts have no edge here by design — the no-inference
 * guarantee (§5.4) lives in the machine, which refuses to transition without a
 * definite verdict.
 *
 * Shape (fix→revalidate→uat loop):
 *   scope ─pass→ impl ─pass→ uat ─pass→ review ─pass→ ship ─pass→ merge ─pass→ done
 *                            ↑ │              │
 *                            │ fail          fail
 *                            │  ▼              ▼
 *                            └─ fix ←──────────┘
 *
 * `ship` ends where the PRs exist, NOT where the work landed. `merge` is the
 * stage that owns the gap between the two: it is entered the moment every PR is
 * open and it passes only once every one of them reads merged upstream (or the
 * ticket delivered nothing to merge at all). Before it existed, `ship ─pass→
 * done` marked a ticket done — and pushed the provider's done status — while the
 * branch was still unmerged and could still conflict.
 *
 * `fix` always returns to `uat`. A review failure re-validates from uat because a
 * fix made for a review finding is still unvalidated code, and the two keys a
 * split would need are distinguishable only by WHICH gate failed — which
 * `gate_runs` already records, append-only, per stage and attempt.
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
  fix: { passed: 'uat' }, // revalidate: every fix re-enters uat, whichever gate failed
  ship: { passed: 'merge' },
  merge: { passed: 'done' },
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

/**
 * True when a stage is reached ONLY by a failed verdict — a return channel, not
 * a step on the forward path. `fix` is the one today.
 *
 * Requires at least one inbound edge, so the entry stage (`scope`, which nothing
 * reaches) stays on the main line rather than being pushed off it.
 *
 * Derived from the table, like isTerminal, so a second branch never has to be
 * remembered here. This is the distinction the dashboard rail failed to make:
 * projecting all of STAGE_KEYS onto a line drew `fix` as a step between review
 * and ship, claiming a forward path that does not exist.
 */
export function isBranch(stage: StageKey): boolean {
  const inbound = Object.values(STAGE_GRAPH).flatMap((edges) => [
    ...(edges.passed === stage ? (['passed'] as const) : []),
    ...(edges.failed === stage ? (['failed'] as const) : []),
  ]);
  return inbound.length > 0 && inbound.every((kind) => kind === 'failed');
}

/** The forward path: every stage except the return channels, in canonical order. */
export const MAIN_LINE: readonly StageKey[] = STAGE_KEYS.filter((k) => !isBranch(k));

/**
 * Stages that do not start themselves — reaching one parks the ticket until the
 * user acts. Both of today's members open onto GitHub, the one place karst
 * deliberately never acts on its own:
 *
 *  - `ship` opens PRs, an irreversible, outward-facing step, so it waits for the
 *    dashboard's "Confirm ship" click.
 *  - `merge` lands them, which is more irreversible still. It waits for the
 *    per-repo "Merge" click (or for a teammate to merge upstream, which the PR
 *    sweep notices) — and, when the probe says the branch no longer merges
 *    cleanly, for a human to resolve the conflict. Parking as pending is what
 *    makes an unmerged ticket read `Needs you` everywhere instead of `Done`.
 *
 * This is the ONE place that fact is written down. The driver already treats
 * ship as a human boundary (`ship-confirm`) and the dashboard already offers the
 * button, but neither told the glyph/badge/facet derivation — which is why a
 * ticket blocked on the user never reported itself as needs-you.
 *
 * A named list rather than a graph-derived predicate, deliberately: "no verdict
 * arrives without a human" is a policy about the stage's side effects, not a
 * shape the edges can express — `impl` also waits on a human and is not one.
 */
export const CONFIRM_STAGES: readonly StageKey[] = ['ship', 'merge'] as const;

/** True when a stage is blocked on an explicit user action to proceed. */
export function needsConfirm(stage: StageKey): boolean {
  return CONFIRM_STAGES.includes(stage);
}

/** Stages whose `failed` verdict routes to the fix loop. */
export const GATE_STAGES: readonly StageKey[] = ['uat', 'review'] as const;

/** True when a stage sends a failed ticket into `fix`. */
export function isGate(stage: StageKey): boolean {
  return GATE_STAGES.includes(stage);
}
