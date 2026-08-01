import { randomUUID } from 'node:crypto';
import { link, lstat, rename, rm } from 'node:fs/promises';
import { attachmentDir, attachmentPath } from './paths.js';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

export interface StagedAttachmentRemoval {
  destination: string;
  stagedPath: string;
}

/** Remove every attachment stored for a ticket. Missing directories are normal. */
export async function reapAttachments(storageDir: string, ticketId: number): Promise<void> {
  await rm(attachmentDir(storageDir, ticketId), { recursive: true, force: true });
}

/**
 * Remove one detached attachment, leaving its ticket directory available for
 * later writes. Caller precondition: the store has established that no other
 * row for this ticket references `storedName` (or that the parent ticket no
 * longer exists, so no attachment row can reference it).
 */
export async function unlinkAttachment(
  storageDir: string,
  ticketId: number,
  storedName: string,
): Promise<void> {
  await rm(attachmentPath(storageDir, ticketId, storedName), { force: true });
}

/**
 * Move a last-reference destination aside without overwriting any path. Keeping
 * the bytes recoverable until unlink succeeds lets the caller release its DB
 * detach claim and restore the file when the filesystem rejects removal.
 */
export async function stageAttachmentRemoval(
  storageDir: string,
  ticketId: number,
  storedName: string,
  detachToken?: string,
): Promise<StagedAttachmentRemoval | null> {
  const destination = attachmentPath(storageDir, ticketId, storedName);
  // Production passes the persisted detach token, making the staging path
  // discoverable after a host crash. Tests/standalone callers keep uniqueness.
  const tokenCandidate = detachToken?.split(':').at(-1);
  const tokenSuffix = tokenCandidate && /^[0-9a-f-]{36}$/i.test(tokenCandidate)
    ? tokenCandidate
    : randomUUID();
  const stagedPath = attachmentPath(storageDir, ticketId, `.detach-${tokenSuffix}.tmp`);
  try {
    const info = await lstat(destination);
    if (!info.isFile()) {
      throw new Error(`${destination} is not a regular file (it may be a directory)`);
    }
    // A retained token may be resuming after an earlier host died. If both
    // links exist, the published destination is authoritative; remove the old
    // private link before staging the same content address again.
    await rm(stagedPath, { force: true });
    await rename(destination, stagedPath);
    return { destination, stagedPath };
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    try {
      const stagedInfo = await lstat(stagedPath);
      if (!stagedInfo.isFile()) {
        throw new Error(`${stagedPath} is not a regular file (it may be a directory)`);
      }
      return { destination, stagedPath };
    } catch (stagedError) {
      if (hasCode(stagedError, 'ENOENT')) return null;
      throw stagedError;
    }
  }
}

/** Permanently remove bytes previously moved aside by stageAttachmentRemoval. */
export async function discardStagedAttachment(
  staged: StagedAttachmentRemoval | null,
): Promise<void> {
  if (staged) await rm(staged.stagedPath, { force: true });
}

/**
 * Roll a failed staged removal back without replacing bytes a concurrent attach
 * may already have published. A successful/EEXIST restore always discards the
 * private staging link; an unexpected failure leaves it for diagnosis/retry.
 */
export async function restoreStagedAttachment(
  staged: StagedAttachmentRemoval | null,
): Promise<void> {
  if (!staged) return;
  try {
    await link(staged.stagedPath, staged.destination);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await rm(staged.stagedPath, { force: true });
}
