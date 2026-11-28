import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { MIRROR_MAX_BYTES, isMirrorName, type MirrorKind } from './mirror.js';

/**
 * Host side of the D556 transcript and mirror trees (`@arch:AC-71`).
 *
 * Two jobs, both on paths the REMOTE chooses:
 *
 * 1. `openHostTranscript` appends one forwarded `.jsonl` into the host bridge
 *    dir. Every part is validated by the caller (at most 2 parts below
 *    `claude-projects/`, at most 4 for codex), the parent must be a REAL
 *    directory (a planted symlink is refused), and the file is opened
 *    `O_APPEND|O_CREAT|O_NOFOLLOW` and must be a regular file.
 * 2. `readMirrorDir` reads the host `attachments/` and `logs/` copies the
 *    launch/gate already made (`bridge/mirror.ts`, same 2 MB cap) so
 *    `mirrorToRemote` can copy them into the remote run dir. A link, a
 *    non-regular file or an oversized one is skipped, never followed.
 */

const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The one path part shape a forwarded name may use; the caller also bounds the depth. */
const HOST_PART = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The append handle of one forwarded transcript, or `undefined` when the host
 * side is not safe: a bad part, a symlinked/non-directory parent, or a planted
 * symlink at the file itself. The caller logs and skips it.
 */
export async function openHostTranscript(hostBridgeDir: string, hostRel: string): Promise<FileHandle | undefined> {
  const parts = hostRel.split('/');
  if (parts.length < 2) return undefined;
  if (!parts.every((part) => part !== '.' && part !== '..' && HOST_PART.test(part))) return undefined;
  let dir = hostBridgeDir.replace(/\/+$/, '');
  for (const part of parts.slice(0, -1)) {
    dir = `${dir}/${part}`;
    let st = await lstat(dir).catch(() => undefined);
    if (st === undefined) {
      await mkdir(dir, { recursive: false, mode: 0o777 }).catch(() => undefined);
      st = await lstat(dir).catch(() => undefined);
    }
    if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) return undefined;
  }
  let handle: FileHandle;
  try {
    handle = await open(`${dir}/${parts[parts.length - 1]!}`, APPEND_FLAGS, 0o666);
  } catch {
    return undefined;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      return undefined;
    }
    return handle;
  } catch {
    await handle.close().catch(() => undefined);
    return undefined;
  }
}

export interface HostMirrorFile {
  /** The bridge-relative name (`attachments/<name>`, `logs/<name>`). */
  readonly rel: string;
  readonly body: Buffer;
}

export interface HostMirrorRead {
  readonly files: readonly HostMirrorFile[];
  /** Names refused (a link, a directory, a FIFO or an oversized copy). */
  readonly skipped: readonly string[];
}

/**
 * Read the regular files of one host mirror dir (`attachments`/`logs`),
 * skipping every name `isMirrorName` refuses, every link, non-regular file and
 * ever one over the 2 MB cap. A missing dir is empty.
 */
export async function readMirrorDir(hostBridgeDir: string, kind: MirrorKind): Promise<HostMirrorRead> {
  const dir = `${hostBridgeDir.replace(/\/+$/, '')}/${kind}`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { files: [], skipped: [] };
  }
  const files: HostMirrorFile[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (!isMirrorName(name)) {
      skipped.push(name);
      continue;
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(`${dir}/${name}`, READ_FLAGS);
      const st = await handle.stat();
      if (!st.isFile() || st.size > MIRROR_MAX_BYTES) {
        skipped.push(name);
        continue;
      }
      files.push({ rel: `${kind}/${name}`, body: await handle.readFile() });
    } catch {
      skipped.push(name);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return { files, skipped };
}
