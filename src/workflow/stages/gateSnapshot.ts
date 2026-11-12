import type { Manifest } from '../../manifest/types.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { allWorktreeTargets, type ReviewWorktree } from '../gates/targets.js';
import { resolveReviewGates } from '../review/gates.js';
import type { Store } from '../../store/db.js';
import { getStageGateSnapshot, setStageGateSnapshot, type GateSnapshot } from '../../store/ticketGates.js';
import { resolveTargetGates } from './uat.js';
import type { ResolvedGate } from '../gates/resolve.js';
import { baseDefinesScript, cutDefinesScript } from '../gates/npmScript.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';

/** True when the base branch of a worktree defines the npm script (so a rebase would bring it). */
export type BaseDefines = (cwd: string, baseRef: string, script: string) => Promise<boolean>;

/** True/false when the commit the branch was cut from defines the script; null when it cannot be read. */
export type CutDefines = (cwd: string, baseRef: string, script: string) => Promise<boolean | null>;

const gitCutDefines: CutDefines = (cwd, baseRef, script) => cutDefinesScript(defaultGitRunner, cwd, baseRef, script);

/** The git seams of the snapshot: what the base defines now, and what the branch was cut with. */
export interface SnapshotGit {
  readonly baseDefines: BaseDefines;
  readonly cutDefines: CutDefines;
}

const gitBaseDefines: BaseDefines = (cwd, baseRef, script) => baseDefinesScript(defaultGitRunner, cwd, baseRef, script);

const DEFAULT_GIT: SnapshotGit = { baseDefines: gitBaseDefines, cutDefines: gitCutDefines };

/** The snapshot's git seams over one `GitRunner` (a stage runs every git call through its own). */
export function snapshotGitFor(git: GitRunner): SnapshotGit {
  return {
    baseDefines: (cwd, baseRef, script) => baseDefinesScript(git, cwd, baseRef, script),
    cutDefines: (cwd, baseRef, script) => cutDefinesScript(git, cwd, baseRef, script),
  };
}

/**
 * The declared gates the worktree can run now. A discovered gate is left out: the
 * branch can add its own package.json script later. A declared script gate whose
 * script the worktree lacks is left out only when the base branch defines it: then
 * "Rebase on base" brings the script and takes the gate into a later snapshot. When
 * the base lacks the script too (or the base is unknown), the gate stays in, so it
 * fails with the real reason instead of a false "added after this ticket started".
 * "The worktree lacks the script" is read from the commit the branch was cut from, not from the
 * worktree files: the first snapshot can be taken after the agent edited the branch, and an edit that
 * removes a script must not hide the gate. The worktree files are the fallback when the cut point or
 * the base ref is unknown.
 * `declared` counts the declared gates seen, left out or not: a stage whose only declared gate is new has
 * an empty name list but still needs a snapshot, or the new gate would run.
 * An unreadable package.json throws: a transient fault must not write a partial snapshot.
 */
async function snapshotNames(
  resolved: { kind: string; gates?: ResolvedGate[]; skipped?: ResolvedGate[] },
  probe: ScriptProbe,
  target: { path: string; baseRef?: string | null },
  git: SnapshotGit,
): Promise<{ names: string[]; declared: number }> {
  const out: string[] = [];
  let declared = 0;
  if (resolved.kind !== 'gates') return { names: out, declared };
  for (const g of [...(resolved.gates ?? []), ...(resolved.skipped ?? [])]) {
    if (!g.required) continue;
    declared++;
    if (g.script !== null) {
      if (probe.kind === 'io-error') throw new Error(`cannot read package.json: ${probe.message}`);
      const onWorktree = probe.kind === 'ok' && probe.scripts[g.script] !== undefined;
      const onCut = target.baseRef != null ? await git.cutDefines(target.path, target.baseRef, g.script) : null;
      const cutWith = onCut ?? onWorktree;
      if (!cutWith && target.baseRef != null && (await git.baseDefines(target.path, target.baseRef, g.script))) continue;
    }
    out.push(g.name);
  }
  return { names: out, declared };
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
  git: SnapshotGit = DEFAULT_GIT,
): Promise<GateSnapshot> {
  const uat = new Set<string>();
  const review = new Set<string>();
  let uatDeclared = 0;
  let reviewDeclared = 0;
  for (const target of allWorktreeTargets(manifest, worktrees)) {
    const scriptProbe = probe(target.path);
    const u = resolveTargetGates(scriptProbe, manifest.uat, target.names, [], debug);
    const un = await snapshotNames(u, scriptProbe, target, git);
    uatDeclared += un.declared;
    for (const n of un.names) uat.add(n);
    const r = resolveReviewGates(scriptProbe, manifest.review, target.names, [], debug);
    const rn = await snapshotNames(r, scriptProbe, target, git);
    reviewDeclared += rn.declared;
    for (const n of rn.names) review.add(n);
  }
  // null: no declared gate resolved for the stage (nothing to snapshot); [] : all were left out.
  return { uat: uatDeclared > 0 ? [...uat] : null, review: reviewDeclared > 0 ? [...review] : null };
}

/**
 * Write the ticket's first snapshot from the gates of every owned repository.
 * A stage is written only when it has no snapshot yet and at least one declared gate
 * resolved: no declared gate means karst could not match the repositories. A stage
 * whose declared gates were all left out is written empty, so the run skips them.
 */
export async function captureGateSnapshot(
  store: Store,
  ticketId: number,
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  probe: (cwd: string) => ScriptProbe = probeScripts,
  debug?: (message: string) => void,
  git: SnapshotGit = DEFAULT_GIT,
): Promise<void> {
  let snapshot: GateSnapshot;
  try {
    snapshot = await collectGateSnapshot(manifest, worktrees, probe, debug, git);
  } catch (err) {
    // A snapshot is a best-effort guard: a failed read must never fail a gate run, and
    // leaving the snapshot unset keeps every gate running.
    debug?.(`[gate] snapshot ticket ${ticketId}: not captured (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  for (const stage of ['uat', 'review'] as const) {
    const names = snapshot[stage];
    if (names === null) continue;
    if (getStageGateSnapshot(store, ticketId, stage) !== null) continue;
    setStageGateSnapshot(store, ticketId, stage, names);
  }
}
