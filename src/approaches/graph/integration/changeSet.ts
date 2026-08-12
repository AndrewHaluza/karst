/**
 * Change-set capture and claim validation (Slice 3 Task 8).
 *
 * The actual diff of a completing node is captured per physical repository as
 * parsed `git diff --name-status` output — PARSED output, in the same spirit
 * as the merge-probe lesson: a rename line carries a second path field, so a
 * naive tab-split of the whole document invents paths. Validation compares
 * every changed path against the node's DECLARED writes; a claim is an exact
 * file or a directory subtree, matched on separator boundaries so `abc`
 * never covers `abc-2`. An out-of-claim mutation blocks BEFORE integration —
 * V1 never silently widens a running node's claim.
 *
 * Host-agnostic: the async `GitRunner` is injected.
 */

import type { GitRunner } from '../../../integrations/git.js';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangeSetEntry {
  path: string;
  kind: ChangeKind;
}

/** The bound on one captured change set (paths are bounded, never open). */
export const MAX_CHANGE_SET_PATHS = 500;
/** The bound on reported violations (the rest are counted, not listed). */
export const MAX_VIOLATIONS_REPORTED = 20;

const KIND_BY_CODE: Readonly<Record<string, ChangeKind>> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  U: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
};

/**
 * Parse `git diff --name-status` stdout. Each line is `XY\tpath` or, for
 * renames/copies (status `R`/`C`), `XY\told\tnew`; the NEW path is the one
 * that exists in the result tree. Only rename/copy lines carry a second
 * field — a tab inside a regular path is part of the path, never a separator.
 * Lines that do not fit the shape (blank lines, git chatter) are ignored;
 * the result never exceeds `MAX_CHANGE_SET_PATHS`.
 */
export function parseNameStatus(stdout: string): ChangeSetEntry[] {
  const entries: ChangeSetEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (entries.length >= MAX_CHANGE_SET_PATHS) break;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue; // no code field, or a blank line
    const code = line.slice(0, tab);
    const kind = KIND_BY_CODE[code[0] ?? ''];
    if (!kind) continue;
    const rest = line.slice(tab + 1);
    const path =
      kind === 'renamed' ? rest.slice(rest.indexOf('\t') + 1) : rest;
    if (path === '') continue;
    entries.push({ path, kind });
  }
  return entries;
}

/**
 * Capture the actual change set of a workspace against a base ref: the union
 * of staged and unstaged changes relative to `baseRef`, parsed.
 */
export async function captureChangeSet(
  git: GitRunner,
  opts: { cwd: string; baseRef: string },
): Promise<ChangeSetEntry[]> {
  const result = await git(['diff', '--name-status', opts.baseRef], opts.cwd);
  if (result.exitCode !== 0) {
    // A failed diff is not evidence of an empty change set: the caller must
    // not integrate on a guess. Throw a named error the pipeline blocks on.
    throw new Error(`git diff --name-status ${opts.baseRef} failed (exit ${result.exitCode})`);
  }
  return parseNameStatus(result.stdout);
}

/**
 * Whether a changed path is inside a declared claim. A claim is an exact
 * file OR a directory subtree; both are matched without a marker, because
 * an exact-file claim can never have a descendant (no `/` may follow it) and
 * a subtree claim covers itself and everything under it. The prefix compare
 * is on a separator boundary: `src/abc` never covers `src/abc-2`.
 */
export function isPathWithinClaim(path: string, claim: string): boolean {
  if (path === claim) return true;
  return path.startsWith(`${claim}/`);
}

export type ClaimValidation =
  | { ok: true }
  | { ok: false; violations: string[] };

/**
 * Compare the actual change set with the declared writes. Every changed path
 * must be inside at least one declared claim; violations are capped at
 * `MAX_VIOLATIONS_REPORTED`. An EMPTY change set always passes — nothing was
 * written, so nothing can be out of claim.
 */
export function validateChangeSet(
  declared: readonly string[],
  entries: readonly ChangeSetEntry[],
): ClaimValidation {
  if (entries.length === 0) return { ok: true };
  const violations: string[] = [];
  for (const entry of entries) {
    if (violations.length >= MAX_VIOLATIONS_REPORTED) break;
    if (!declared.some((claim) => isPathWithinClaim(entry.path, claim))) {
      violations.push(entry.path);
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
