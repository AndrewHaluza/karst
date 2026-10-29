import type { GitRunner } from '../../integrations/git.js';
import { resolveMergeBase } from './baselineReview.js';
import type { ResolvedGate } from './resolve.js';
import { hasUiChange, isUiGate, NO_UI_CHANGE_REASON } from './uiScope.js';

/**
 * Cut the UI gates out of a resolved list when the branch changed no UI path.
 *
 * The cut ones are returned as `skipped`, so the caller records them as
 * evidence (a skip is not a pass). Any git failure keeps every gate: not
 * knowing the diff must never remove a check.
 */
export async function cutGatesWithoutUiChange(
  gates: readonly ResolvedGate[],
  git: GitRunner,
  cwd: string,
  baseRef: string,
  debug?: (message: string) => void,
): Promise<{ kept: ResolvedGate[]; skipped: ResolvedGate[] }> {
  if (!gates.some(isUiGate)) return { kept: [...gates], skipped: [] };
  try {
    const mergeBase = await resolveMergeBase(git, cwd, baseRef);
    const diff = await git(['diff', '--name-only', '-z', mergeBase, 'HEAD'], cwd);
    if (diff.exitCode !== 0) throw new Error(diff.stderr.trim());
    if (hasUiChange(diff.stdout.split('\0').filter((p) => p !== ''))) {
      return { kept: [...gates], skipped: [] };
    }
    debug?.(`[gate] ui diff: ${NO_UI_CHANGE_REASON} in ${cwd} — skipping UI gates`);
    return { kept: gates.filter((g) => !isUiGate(g)), skipped: gates.filter(isUiGate) };
  } catch (err) {
    debug?.(`[gate] ui diff: unreadable (${String(err)}) — keeping every gate`);
    return { kept: [...gates], skipped: [] };
  }
}
