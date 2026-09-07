import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Absolute paths belonging to the machine a file was WRITTEN on. A generated
 * artifact that carries one is dead everywhere else, so these are the shapes the
 * `.agents/` guard refuses. Deliberately narrow: only path prefixes that can
 * only be a host root, never a repo-relative path a document legitimately names.
 */
export const ABSOLUTE_HOST_PATH_PATTERNS: readonly RegExp[] = [
  // macOS home dirs.
  /\/Users\/[^\s"'`)\]]+/gu,
  // Linux home dirs.
  /\/home\/[^\s"'`)\]]+/gu,
  // Windows drive-letter roots (`C:\Users\...`, `D:\work\...`).
  /[A-Za-z]:\\[^\s"'`)\]]+/gu,
];

/** Every absolute host path in `text`, deduplicated, in first-seen order. */
export function findAbsoluteHostPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const pattern of ABSOLUTE_HOST_PATH_PATTERNS) {
    // A `g` regex carries lastIndex across calls; match on a fresh copy.
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) {
      seen.add(match[0]!);
    }
  }
  return [...seen];
}

/**
 * Absolute paths of every git-TRACKED file under `<repoRoot>/<subdir>`. Unlike
 * a disk walk, this ignores generated/untracked content that regenerates into
 * the working tree on every launch — the guard this feeds is about what's
 * committed, not what's on disk right now. A `subdir` git doesn't know about
 * (outside the repo, or nonexistent) yields `[]` rather than throwing.
 */
export function listTrackedFiles(repoRoot: string, subdir: string): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '-z', '--', subdir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => join(repoRoot, entry));
}
