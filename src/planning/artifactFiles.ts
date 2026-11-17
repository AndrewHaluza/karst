import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The deepest sub-directory level the count enters. */
const MAX_DEPTH = 4;

/** The count stops here: the sidebar needs "none" or "some", not an exact total. */
const MAX_COUNT = 1000;

/**
 * How many files a planning session's artifacts dir holds (sub-directories are
 * entered, bounded). 0 when the dir is missing or unreadable. A sync read: the
 * sidebar calls it at state build, and the dir is small.
 */
export function countArtifactFiles(dir: string, depth = 0): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing dir is the normal "no artifacts yet" state, not an error.
    return 0;
  }
  let count = 0;
  for (const e of entries) {
    if (count >= MAX_COUNT) break;
    if (e.isFile()) count += 1;
    else if (e.isDirectory() && depth < MAX_DEPTH) count += countArtifactFiles(join(dir, e.name), depth + 1);
  }
  return count;
}
