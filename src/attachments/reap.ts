import { rm } from 'node:fs/promises';
import { attachmentDir, attachmentPath } from './paths.js';

/** Remove every attachment stored for a ticket. Missing directories are normal. */
export async function reapAttachments(storageDir: string, ticketId: number): Promise<void> {
  await rm(attachmentDir(storageDir, ticketId), { recursive: true, force: true });
}

/** Remove one detached attachment, leaving its ticket directory available for later writes. */
export async function unlinkAttachment(
  storageDir: string,
  ticketId: number,
  storedName: string,
): Promise<void> {
  await rm(attachmentPath(storageDir, ticketId, storedName), { force: true });
}
