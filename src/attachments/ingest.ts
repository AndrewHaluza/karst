import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, link, rm, writeFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { attachmentDir, attachmentPath } from './paths.js';
import {
  attachmentKind,
  attachmentExtension,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './kinds.js';
import type { AttachmentInput } from '../store/attachments.js';

/** The maximum number of bytes accepted through the webview paste path. */
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

export type IngestResult =
  | { ok: true; input: AttachmentInput }
  | { ok: false; message: string };

const SUPPORTED = `images: ${IMAGE_EXTENSIONS.join(', ')}; video: ${VIDEO_EXTENSIONS.join(', ')}`;

function unsupported(name: string): IngestResult {
  return { ok: false, message: `${name} is not a supported attachment (${SUPPORTED})` };
}

function shortHash(digest: string): string {
  return digest.slice(0, 16);
}

/** Hash a picked file incrementally so a large video never occupies one buffer. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return shortHash(hash.digest('hex'));
}

function hashBytes(bytes: Buffer): string {
  return shortHash(createHash('sha256').update(bytes).digest('hex'));
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

/**
 * Copy a native-picker file under a content-addressed filename. The original
 * name is display data only; its normalized whitelist extension is the only
 * user-derived portion of the on-disk name.
 */
export async function ingestFile(
  storageDir: string,
  ticketId: number,
  sourcePath: string,
): Promise<IngestResult> {
  const originalName = basename(sourcePath);
  const kind = attachmentKind(originalName);
  const ext = attachmentExtension(originalName);
  if (kind === null || ext === null) return unsupported(originalName);

  const directory = attachmentDir(storageDir, ticketId);
  const temporaryPath = attachmentPath(storageDir, ticketId, `.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await copyFile(sourcePath, temporaryPath);
    const { size } = await stat(temporaryPath);
    const hash = await hashFile(temporaryPath);
    const storedName = `${hash}.${ext}`;
    const destination = attachmentPath(storageDir, ticketId, storedName);

    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isAlreadyExists(error) || (await hashFile(destination)) !== hash) throw error;
    }

    return { ok: true, input: { ticketId, kind, storedName, originalName, byteSize: size } };
  } catch {
    return { ok: false, message: `${originalName} could not be read` };
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // A failed cleanup must not turn a completed ingest into an exception.
    }
  }
}

/** Write webview-pasted bytes after enforcing the transport size ceiling. */
export async function ingestBytes(
  storageDir: string,
  ticketId: number,
  originalName: string,
  bytes: Buffer,
): Promise<IngestResult> {
  const kind = attachmentKind(originalName);
  const ext = attachmentExtension(originalName);
  if (kind === null || ext === null) return unsupported(originalName);

  if (bytes.byteLength > MAX_PASTE_BYTES) {
    const mb = Math.round(MAX_PASTE_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `${originalName} is too large to paste (limit ${mb} MB). Use Attach to add it from disk.`,
    };
  }

  try {
    const storedName = `${hashBytes(bytes)}.${ext}`;
    await mkdir(attachmentDir(storageDir, ticketId), { recursive: true });
    await writeFile(attachmentPath(storageDir, ticketId, storedName), bytes);
    return {
      ok: true,
      input: { ticketId, kind, storedName, originalName, byteSize: bytes.byteLength },
    };
  } catch {
    return { ok: false, message: `${originalName} could not be saved` };
  }
}
