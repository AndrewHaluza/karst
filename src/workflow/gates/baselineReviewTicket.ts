import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { resolveTicketBaseRef } from '../baseRef.js';
import {
  detectBaselineChanges,
  type BaselineDetectDeps,
  type BaselineEntry,
} from './baselineReview.js';

/**
 * The ticket-level seam over `detectBaselineChanges` (@arch:BASELINE-REVIEW):
 * resolves each worktree's base the way ship and sub-tasks do, so the UAT gate,
 * the report and the decision handler all derive the SAME entries. Empty when
 * the manifest does not opt in. Throws when git cannot answer (see the detector).
 */
export async function detectTicketBaselines(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  worktrees: ReadonlyArray<{ repo: string; path: string }>,
  deps: BaselineDetectDeps,
): Promise<BaselineEntry[]> {
  const globs = manifest?.uat?.baselineReview?.paths ?? [];
  if (!manifest || globs.length === 0) return [];
  const repos = worktrees.map((wt) => ({
    repo: wt.repo,
    cwd: wt.path,
    baseRef: resolveTicketBaseRef(store, ticketId, wt.repo, manifest),
  }));
  return detectBaselineChanges(deps, repos, globs);
}
