import { constants as fsConstants } from 'node:fs';
import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { sep } from 'node:path';

/** A transcript above this size is refused, never read whole into memory. */
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
// Same flags as the bridge poller: a planted symlink is refused, a planted FIFO cannot block open().
const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export interface TranscriptReader {
  stat(path: string): Promise<{ readonly mtimeMs: number; readonly size: number }>;
  readFile(path: string): Promise<string>;
}

async function withinRoot(path: string, root: string): Promise<void> {
  // realpath throws ENOENT for a missing file: the caller treats that as "no transcript yet".
  const [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (!real.startsWith(realRoot + sep)) throw new Error('transcript path is outside the bridge directory');
}

async function openChecked(path: string, root: string | undefined): Promise<{ handle: FileHandle; mtimeMs: number; size: number }> {
  if (root !== undefined) await withinRoot(path, root);
  const handle = await open(path, OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('transcript is not a regular file');
    if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript is too large');
    return { handle, mtimeMs: st.mtimeMs, size: st.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Reads a transcript the agent may have written. With a `root` (the sandbox bridge
 * directory) the resolved path must stay inside it, so a linked directory cannot
 * point the host at another file.
 */
export function makeTranscriptReader(root?: string): TranscriptReader {
  // A host transcript is written by the host agent: it keeps the plain read, with no sandbox limits.
  if (root === undefined) {
    return {
      async stat(path) {
        const st = await stat(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
      },
      readFile: (path) => readFile(path, 'utf8'),
    };
  }
  return {
    async stat(path) {
      const { handle, mtimeMs, size } = await openChecked(path, root);
      await handle.close();
      return { mtimeMs, size };
    },
    async readFile(path) {
      const { handle } = await openChecked(path, root);
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    },
  };
}
