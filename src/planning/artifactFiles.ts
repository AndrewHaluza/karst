import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The deepest sub-directory level the scan enters. */
const MAX_DEPTH = 2;

/**
 * Whether a planning session's artifacts dir holds at least one file (sub-dirs
 * are entered, bounded). False when the dir is missing or unreadable. The scan
 * is async (never blocks the extension host) and stops at the first file.
 */
export async function hasArtifactFiles(dir: string, depth = 0): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing dir is the normal "no artifacts yet" state, not an error.
    return false;
  }
  if (entries.some((e) => e.isFile())) return true;
  if (depth >= MAX_DEPTH) return false;
  for (const e of entries) {
    if (e.isDirectory() && (await hasArtifactFiles(join(dir, e.name), depth + 1))) return true;
  }
  return false;
}
