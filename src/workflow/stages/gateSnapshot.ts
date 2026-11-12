import type { Manifest } from '../../manifest/types.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { allWorktreeTargets, type ReviewWorktree } from '../gates/targets.js';
import { resolveReviewGates } from '../review/gates.js';
import type { Store } from '../../store/db.js';
import { getStageGateSnapshot, setStageGateSnapshot, type GateSnapshot } from '../../store/ticketGates.js';
import { resolveTargetGates } from './uat.js';
import type { ResolvedGate } from '../gates/resolve.js';
import { baseDefinesScript } from '../gates/npmScript.js';
import { defaultGitRunner } from '../../integrations/git.js';

/** True when the base branch of a worktree defines the npm script (so a rebase would bring it). */
export type BaseDefines = (cwd: string, baseRef: string, script: string) => Promise<boolean>;

const gitBaseDefines: BaseDefines = (cwd, baseRef, script) => baseDefinesScript(defaultGitRunner, cwd, baseRef, script);

/**
 * The declared gates the worktree can run now. A discovered gate is left out: the
 * branch can add its own package.json script later. A declared script gate whose
 * script the worktree lacks is left out only when the base branch defines it: then
 * "Rebase on base" brings the script and takes the gate into a later snapshot. When
 * the base lacks the script too (or the base is unknown), the gate stays in, so it
 * fails with the real reason instead of a false "added after this ticket started".
 * An unreadable package.json throws: a transient fault must not write a partial snapshot.
 */
async function snapshotNames(
  resolved: { kind: string; gates?: ResolvedGate[]; skipped?: ResolvedGate[] },
  probe: ScriptProbe,
  target: { path: string; baseRef?: string | null },
  baseDefines: BaseDefines,
): Promise<string[]> {
  if (resolved.kind !== 'gates') return [];
  const out: string[] = [];
  for (const g of [...(resolved.gates ?? []), ...(resolved.skipped ?? [])]) {
    if (!g.required) continue;
    if (g.script !== null) {
      if (probe.kind === 'io-error') throw new Error(`cannot read package.json: ${probe.message}`);
      const onBranch = probe.kind === 'ok' && probe.scripts[g.script] !== undefined;
      if (!onBranch && target.baseRef != null && (await baseDefines(target.path, target.baseRef, g.script))) continue;
    }
    out.push(g.name);
  }
  return out;
}

/**
 * The gate-set snapshot of a ticket (@arch:GATE-SNAPSHOT): the RESOLVED gate names
 * of each stage over EVERY repository the ticket owns, changed or not. A repository
 * that has no diff now can change later, and a snapshot that left its gates out
 * would skip them as "added after this ticket started". A gate switched off in
 * Settings is still listed: it exists, so it is not "added later". Only declared
 * gates that the worktree can run are listed (see `snapshotNames`).
 */
export async function collectGateSnapshot(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  probe: (cwd: string) => ScriptProbe = probeScripts,
  debug?: (message: string) => void,
  baseDefines: BaseDefines = gitBaseDefines,
): Promise<GateSnapshot> {
  const uat = new Set<string>();
  const review = new Set<string>();
  for (const target of allWorktreeTargets(manifest, worktrees)) {
    const scriptProbe = probe(target.path);
    const u = resolveTargetGates(scriptProbe, manifest.uat, target.names, [], debug);
    for (const n of await snapshotNames(u, scriptProbe, target, baseDefines)) uat.add(n);
    const r = resolveReviewGates(scriptProbe, manifest.review, target.names, [], debug);
    for (const n of await snapshotNames(r, scriptProbe, target, baseDefines)) review.add(n);
  }
  return { uat: [...uat], review: [...review] };
}

/**
 * Write the ticket's first snapshot from the gates of every owned repository.
 * A stage is written only when it has no snapshot yet and at least one gate
 * resolved: an empty answer means karst could not read the repositories, and an
 * empty snapshot would skip every gate of the stage.
 */
export async function captureGateSnapshot(
  store: Store,
  ticketId: number,
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  probe: (cwd: string) => ScriptProbe = probeScripts,
  debug?: (message: string) => void,
  baseDefines: BaseDefines = gitBaseDefines,
): Promise<void> {
  let snapshot: GateSnapshot;
  try {
    snapshot = await collectGateSnapshot(manifest, worktrees, probe, debug, baseDefines);
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
