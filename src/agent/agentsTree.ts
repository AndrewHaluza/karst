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
    for (const match of text.matchAll(pattern)) {
      seen.add(match[0]!);
    }
  }
  return [...seen];
}

/**
 * Absolute paths of every git-TRACKED file under `<repoRoot>/<subdir>`. Unlike
 * a disk walk, this ignores generated/untracked content that regenerates into
 * the working tree on every launch — the guard this feeds is about what's
 * committed, not what's on disk right now. Two distinct "nothing tracked"
 * paths both end up returning `[]`: a `subdir` that exists in the repo but
 * has no tracked files under it makes `git ls-files` exit 0 with empty
 * output (the normal case, handled below the try/catch); `repoRoot` not
 * being a git checkout at all (or `git` missing) makes it exit non-zero,
 * which lands in the `catch`.
 */
export function listTrackedFiles(repoRoot: string, subdir: string): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '-z', '--', subdir], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => join(repoRoot, entry));
}
