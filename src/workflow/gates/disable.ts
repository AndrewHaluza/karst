import type { BlockerKind } from '../../model/types.js';
import type { ResolvedGate } from './resolve.js';

/**
 * A resolved gate list cut by the ticket's own disable list.
 *
 * `skipped` is carried, never discarded: a gate that silently vanished would be
 * indistinguishable from one the repository never had, which is exactly the
 * conflation `gate_runs.skipped` exists to prevent. The caller records one row
 * per skipped gate so the evidence trail states what did not run and why.
 */
export interface GatePartition {
  kept: ResolvedGate[];
  skipped: ResolvedGate[];
}

/**
 * Split a RESOLVED gate list by name.
 *
 * Applied to `resolveGates`'s output rather than threaded into it on purpose:
 * `resolveGates` answers "what did the config declare, or the repo offer", and a
 * per-ticket cut is a different question asked afterwards. Keeping them apart is
 * what lets one function stay the single declared/discovered rule for both
 * stages.
 *
 * Matching is by EXACT name — the same string the user was shown and clicked.
 * No prefix, no case folding: `test` and `test:integration` are two gates, and a
 * fuzzy match would disable a gate nobody asked to disable.
 *
 * `required` is not respected. A declared gate whose script is missing is a
 * failure precisely because the config named a question the repo cannot answer —
 * but a per-ticket disable IS the user retracting that question, for this ticket
 * only, which is the whole feature.
 */
export function partitionDisabled(
  gates: readonly ResolvedGate[],
  disabledNames: readonly string[],
): GatePartition {
  if (disabledNames.length === 0) return { kept: [...gates], skipped: [] };
  const disabled = new Set(disabledNames);
  const kept: ResolvedGate[] = [];
  const skipped: ResolvedGate[] = [];
  for (const gate of gates) (disabled.has(gate.name) ? skipped : kept).push(gate);
  return { kept, skipped };
}

/**
 * What a STAGE-level resolver answers, once the ticket's own disables are
 * applied. `GateResolution` (`gates/resolve.ts`) stays the config/probe answer;
 * this is that answer minus what the user switched off, and it carries the
 * difference rather than swallowing it.
 *
 * `unavailable` is unchanged and unreachable through a disable: karst could not
 * ASK this repository anything, which no per-ticket preference can alter.
 */
export type StageGateResolution =
  | { kind: 'gates'; gates: ResolvedGate[]; skipped: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };
