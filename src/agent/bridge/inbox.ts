import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BridgePaths } from './bridgeDir.js';

/** A ref names an inbox file and is echoed back in an ack line: only this shape is ever accepted. */
export const INBOX_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Thrown when the agent-writable inbox dir was tampered with; the dir is recreated, the write was refused. */
export class InboxTamperedError extends Error {
  constructor(detail: string) {
    super(`bridge: inbox ${detail}; recreated, this write was refused`);
    this.name = 'InboxTamperedError';
  }
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * `inbox/` sits in an agent-writable rw mount (arch:AC-34). The host `lstat`s it
 * (a real directory, not a link), then writes via temp + rename with
 * `O_NOFOLLOW|O_EXCL` on the temp file: a rename REPLACES an agent-planted file at
 * the target name instead of refusing in a loop. On tamper the dir is recreated
 * and the write refused; the next attempt succeeds. Returns the host path written.
 *
 * Synchronous on purpose: the delivery seams that call it are synchronous, and the
 * write is one small file.
 */
export function writeInboxFile(paths: BridgePaths, ref: string, body: string): string {
  if (!INBOX_REF_PATTERN.test(ref)) throw new Error('bridge: invalid inbox ref');
  const entry = statOrUndefined(paths.inboxDir);
  if (entry === undefined) mkdirSync(paths.inboxDir, { recursive: true, mode: 0o755 });
  else if (entry.isSymbolicLink() || !entry.isDirectory()) {
    rmSync(paths.inboxDir, { recursive: true, force: true });
    mkdirSync(paths.inboxDir, { recursive: true, mode: 0o755 });
    throw new InboxTamperedError(entry.isSymbolicLink() ? 'was a symlink' : 'was not a directory');
  }
  const target = join(paths.inboxDir, `${ref}.md`);
  const temp = join(paths.inboxDir, `.${ref}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  return target;
}
