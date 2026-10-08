/**
 * The project bulletin's relevance rule (v72) — a PURE function, no store, no
 * clock. A note is offered to a ticket when their repos intersect AND their
 * changed paths overlap by prefix; a note whose paths were never stamped (it
 * merged before the probe learned the diff, or the file list came back capped)
 * matches on repo alone, and so does a reader whose own paths are unknown.
 *
 * The note's paths come from the merged diff (recordTicketMerged); the reader's
 * scope is its worktrees' repos plus whatever paths its own notes carry. Prefix
 * matching is on whole path SEGMENTS — `src/store` overlaps `src/store/prs.ts`
 * but never `src/storage`.
 */

/** What a reader (a ticket) brings to the match. */
export interface NoteScope {
  /** The reader's repositories (from its worktrees). */
  repos: readonly string[];
  /** The reader's repo-relative changed paths, or null when unknown. */
  paths: readonly string[] | null;
}

/** What a note brings to the match. Both may be absent (never stamped). */
export interface NoteStamp {
  repos: readonly string[] | null;
  paths: readonly string[] | null;
}

/**
 * Whether two repo-relative paths overlap by prefix. Equal paths overlap; so do
 * a directory and a file beneath it (`a/b` and `a/b/c`). The boundary check
 * stops `a/b` from matching `a/bc` — a plain `startsWith` would.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Whether `note` is relevant to `scope`. A note with no stamped repos matches
 * nothing: with no repo there is no relevance signal at all. With repos
 * intersecting, a note with no stamped paths (or a reader with none) matches on
 * repo alone.
 */
export function noteMatchesScope(note: NoteStamp, scope: NoteScope): boolean {
  const noteRepos = note.repos ?? [];
  if (noteRepos.length === 0 || scope.repos.length === 0) return false;
  if (!noteRepos.some((repo) => scope.repos.includes(repo))) return false;
  const notePaths = note.paths;
  if (!notePaths || notePaths.length === 0) return true;
  const scopePaths = scope.paths;
  if (!scopePaths || scopePaths.length === 0) return true;
  return notePaths.some((p) => scopePaths.some((q) => pathsOverlap(p, q)));
}
