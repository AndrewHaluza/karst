import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner } from '../../integrations/git.js';
import { resolveTicketBaseRef } from '../baseRef.js';
import { gateFingerprint } from './gateFingerprint.js';
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

export interface BaselineHostDeps {
  store: Store;
  manifest: Manifest | undefined;
  git?: BaselineDetectDeps['git'];
  /** Reads a worktree file for hashing; defaults to the filesystem. */
  readFile?: BaselineDetectDeps['readFile'];
}

/**
 * Detection order IS the entry index the webview sends back, so every
 * consumer (report, approve, reject) derives through here and gets one list.
 */
export async function deriveBaselineEntries(
  deps: BaselineHostDeps,
  ticketId: number,
): Promise<BaselineEntry[]> {
  return detectTicketBaselines(
    deps.store,
    deps.manifest,
    ticketId,
    listWorktreesByTicket(deps.store, ticketId),
    { git: deps.git ?? defaultGitRunner, readFile: deps.readFile },
  );
}

/** The fingerprint of a ticket's working trees (`null` when it cannot be computed). */
export async function fingerprintTicket(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  worktrees: ReadonlyArray<{ repo: string; path: string }>,
  deps: BaselineDetectDeps,
): Promise<string | null> {
  return gateFingerprint(
    deps,
    worktrees.map((wt) => ({
      repo: wt.repo,
      cwd: wt.path,
      baseRef: resolveTicketBaseRef(store, ticketId, wt.repo, manifest),
    })),
  );
}
