import type { Manifest } from '../../manifest/types.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { allWorktreeTargets, type ReviewWorktree } from '../gates/targets.js';
import { resolveReviewGates } from '../review/gates.js';
import type { Store } from '../../store/db.js';
import { getStageGateSnapshot, setStageGateSnapshot, type GateSnapshot } from '../../store/ticketGates.js';
import { resolveTargetGates } from './uat.js';

/**
 * The gate-set snapshot of a ticket (@arch:GATE-SNAPSHOT): the RESOLVED gate names
 * of each stage over EVERY repository the ticket owns, changed or not. A repository
 * that has no diff now can change later, and a snapshot that left its gates out
 * would skip them as "added after this ticket started". A gate switched off in
 * Settings is still listed: it exists, so it is not "added later".
 */
export function collectGateSnapshot(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  probe: (cwd: string) => ScriptProbe = probeScripts,
  debug?: (message: string) => void,
): GateSnapshot {
  const uat = new Set<string>();
  const review = new Set<string>();
  for (const target of allWorktreeTargets(manifest, worktrees)) {
    const scriptProbe = probe(target.path);
    const u = resolveTargetGates(scriptProbe, manifest.uat, target.names, [], debug);
    if (u.kind === 'gates') for (const g of [...u.gates, ...u.skipped]) uat.add(g.name);
    const r = resolveReviewGates(scriptProbe, manifest.review, target.names, [], debug);
    if (r.kind === 'gates') for (const g of [...r.gates, ...r.skipped]) review.add(g.name);
  }
  return { uat: [...uat], review: [...review] };
}

/**
 * Write the ticket's first snapshot from the gates of every owned repository.
 * A stage is written only when it has no snapshot yet and at least one gate
 * resolved: an empty answer means karst could not read the repositories, and an
 * empty snapshot would skip every gate of the stage.
 */
export function captureGateSnapshot(
  store: Store,
  ticketId: number,
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  probe: (cwd: string) => ScriptProbe = probeScripts,
  debug?: (message: string) => void,
): void {
  let snapshot: GateSnapshot;
  try {
    snapshot = collectGateSnapshot(manifest, worktrees, probe, debug);
  } catch (err) {
    // A snapshot is a best-effort guard: a failed read must never fail a gate run, and
    // leaving the snapshot unset keeps every gate running.
    debug?.(`[gate] snapshot ticket ${ticketId}: not captured (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  for (const stage of ['uat', 'review'] as const) {
    const names = snapshot[stage];
    if (names === null || names.length === 0) continue;
    if (getStageGateSnapshot(store, ticketId, stage) !== null) continue;
    setStageGateSnapshot(store, ticketId, stage, names);
  }
}
