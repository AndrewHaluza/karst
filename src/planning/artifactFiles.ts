import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The deepest sub-directory level the scan enters. */
const MAX_DEPTH = 2;

/**
 * Whether a planning session's artifacts dir holds at least one file (sub-dirs
 * are entered, bounded). False when the dir is missing or unreadable. The scan
 * stops at the first file, so a dir with files costs one `readdir`: the sidebar
 * calls this at every state build, once per session.
 */
export function hasArtifactFiles(dir: string, depth = 0): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing dir is the normal "no artifacts yet" state, not an error.
    return false;
  }
  if (entries.some((e) => e.isFile())) return true;
  if (depth >= MAX_DEPTH) return false;
  return entries.some((e) => e.isDirectory() && hasArtifactFiles(join(dir, e.name), depth + 1));
}
