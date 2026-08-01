import { join } from 'node:path';

/**
 * Where a ticket's attachment bytes live:
 * `<globalStorage>/attachments/<ticketId>/<storedName>`.
 *
 * The same shape as the existing `<globalStorage>/artifacts/<ticketId>/` layout,
 * and in global storage for the same reason the registry is: every IDE window
 * shares it, so a panel in any window resolves the same file.
 *
 * `attachmentsRoot` is a separate export because it is exactly what the webview
 * is granted as a `localResourceRoots` entry — one directory, covering every
 * ticket, and nothing else on disk.
 *
 * Pure path math. No fs, so it is trivially testable and imports nothing.
 */

export const ATTACHMENTS_ROOT = 'attachments';

/** The single directory every attachment lives under. */
export function attachmentsRoot(storageDir: string): string {
  return join(storageDir, ATTACHMENTS_ROOT);
}

/** One ticket's attachment directory. */
export function attachmentDir(storageDir: string, ticketId: number): string {
  return join(attachmentsRoot(storageDir), String(ticketId));
}

/**
 * The absolute path of one stored file. `storedName` is always a value this
 * codebase generated (`<sha>.<ext>`), never a user-supplied filename — see
 * `ingest.ts`.
 */
export function attachmentPath(
  storageDir: string,
  ticketId: number,
  storedName: string,
): string {
  return join(attachmentDir(storageDir, ticketId), storedName);
}
