import { lstat, mkdir, rm } from 'node:fs/promises';
import { openXfer } from '../xfer.js';
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

/**
 * `inbox/` sits in an agent-writable rw mount (arch:AC-34). The host `lstat`s it
 * (a real directory, not a link), then writes via temp + rename with
 * `O_NOFOLLOW|O_EXCL` on the temp file: a rename REPLACES an agent-planted file at
 * the target name instead of refusing in a loop. On tamper the dir is recreated
 * and the write refused; the next attempt succeeds. Returns the host path written.
 */
export async function writeInboxFile(paths: BridgePaths, ref: string, body: string): Promise<string> {
  if (!INBOX_REF_PATTERN.test(ref)) throw new Error('bridge: invalid inbox ref');
  const entry = await lstat(paths.inboxDir).catch(() => undefined);
  if (entry === undefined) await mkdir(paths.inboxDir, { recursive: true, mode: 0o755 });
  else if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await rm(paths.inboxDir, { recursive: true, force: true });
    await mkdir(paths.inboxDir, { recursive: true, mode: 0o755 });
    throw new InboxTamperedError(entry.isSymbolicLink() ? 'was a symlink' : 'was not a directory');
  }
  const xfer = await openXfer(paths.inboxDir);
  const written = await xfer.write(`${ref}.md`, Buffer.from(body, 'utf8'));
  await xfer.verified(`${ref}.md`);
  return written;
}
