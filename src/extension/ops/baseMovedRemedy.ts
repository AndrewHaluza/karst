import { staleOnlyCommands, type FailedGateText } from '../../workflow/baseMovedStale.js';
import type { BaseRemedy } from '../../workflow/stages/ship.js';

/**
 * The host remedy of a failed base-moved check (T1169, D633, @arch:GATE-BASE-MOVED). When every failed gate held only a
 * stale generated file of `ship.regenerate`, the host rebases on base (the D558 op, with no push and no confirm prompt),
 * then gates the new head. Success needs both: the branch moved and the gates passed. Every collaborator is injected.
 */
export interface BaseMovedRemedyDeps {
  /** The failed gate rows of the newest base-moved run, for this repo. */
  readonly failedGates: () => readonly FailedGateText[];
  /** The `ship.regenerate` commands of the repo. */
  readonly regenerate: readonly string[];
  /** Rebase on base and regenerate, no push. `moved` is true only when the branch head moved with no error. */
  readonly rebase: () => Promise<{ readonly moved: boolean; readonly error: string | null }>;
  /** The ship gates on the rebased branch. Null = pass; else the failure reason. */
  readonly gates: () => Promise<string | null>;
  readonly debug: (message: string) => void;
}

export async function remedyBaseMoved(d: BaseMovedRemedyDeps): Promise<BaseRemedy | null> {
  const commands = staleOnlyCommands(d.failedGates(), d.regenerate);
  if (commands === null) return null;
  const what = commands.join('; ');
  d.debug(`[ship] base-moved: only a stale generated file failed (${what}); the host rebases on base`);
  let rebased: Awaited<ReturnType<BaseMovedRemedyDeps['rebase']>>;
  try {
    rebased = await d.rebase();
  } catch (err) {
    return { kind: 'refused', reason: `rebase on base failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (rebased.error !== null) return { kind: 'refused', reason: `rebase on base stopped: ${rebased.error}` };
  if (!rebased.moved) return { kind: 'refused', reason: 'rebase on base moved nothing, so the stale file stays' };
  const failure = await d.gates().catch((err: unknown) => `gates failed to run: ${err instanceof Error ? err.message : String(err)}`);
  if (failure !== null) return { kind: 'refused', reason: `the gates fail on the rebased head: ${failure}` };
  return { kind: 'rebased', detail: `rebased on base and regenerated (${what}); the gates pass on the new head` };
}
