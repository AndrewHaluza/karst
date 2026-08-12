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

export type AttachmentValidation =
  | { ok: true; kind: NonNullable<ReturnType<typeof attachmentKind>>; extension: string }
  | { ok: false; message: string };

const SUPPORTED = `images: ${IMAGE_EXTENSIONS.join(', ')}; video: ${VIDEO_EXTENSIONS.join(', ')}; any other file`;

function unsupported(name: string): AttachmentValidation {
  return { ok: false, message: `${name} is not a supported attachment (${SUPPORTED})` };
}

/**
 * Validate the user-facing name and, for pasted bytes, the exact decoded size.
 * Host actions call this before binding a create-mode draft; ingest calls the
 * same helper again at the filesystem boundary so the messages cannot drift.
 */
export function validateAttachment(
  originalName: string,
  pastedByteSize?: number,
): AttachmentValidation {
  const kind = attachmentKind(originalName);
  const extension = attachmentExtension(originalName);
  if (kind === null || extension === null) return unsupported(originalName);

  if (pastedByteSize !== undefined && pastedByteSize > MAX_PASTE_BYTES) {
    const mb = Math.round(MAX_PASTE_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `${originalName} is too large to paste (limit ${mb} MB). Use Attach to add it from disk.`,
    };
  }
  return { ok: true, kind, extension };
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
  expectedStoredName?: string,
): Promise<IngestResult> {
  const originalName = basename(sourcePath);
  const validation = validateAttachment(originalName);
  if (!validation.ok) return validation;
  const { kind, extension: ext } = validation;

  const directory = attachmentDir(storageDir, ticketId);
  const temporaryPath = attachmentPath(storageDir, ticketId, `.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await copyFile(sourcePath, temporaryPath);
    const { size } = await stat(temporaryPath);
    const hash = await hashFile(temporaryPath);
    const storedName = `${hash}.${ext}`;
    if (expectedStoredName !== undefined && storedName !== expectedStoredName) {
      return { ok: false, message: `${originalName} changed before it could be saved` };
    }
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

/** Whether the content-addressed destination is currently a regular file. */
export async function attachmentExists(
  storageDir: string,
  ticketId: number,
  storedName: string,
): Promise<boolean> {
  try {
    return (await stat(attachmentPath(storageDir, ticketId, storedName))).isFile();
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

/** Write webview-pasted bytes after enforcing the transport size ceiling. */
export async function ingestBytes(
  storageDir: string,
  ticketId: number,
  originalName: string,
  bytes: Buffer,
): Promise<IngestResult> {
  const validation = validateAttachment(originalName, bytes.byteLength);
  if (!validation.ok) return validation;
  const { kind, extension: ext } = validation;

  const temporaryPath = attachmentPath(storageDir, ticketId, `.${randomUUID()}.tmp`);
  try {
    const hash = hashBytes(bytes);
    const storedName = `${hash}.${ext}`;
    await mkdir(attachmentDir(storageDir, ticketId), { recursive: true });
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    const destination = attachmentPath(storageDir, ticketId, storedName);
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isAlreadyExists(error) || (await hashFile(destination)) !== hash) {
        throw error;
      }
    }
    return {
      ok: true,
      input: { ticketId, kind, storedName, originalName, byteSize: bytes.byteLength },
    };
  } catch {
    return { ok: false, message: `${originalName} could not be saved` };
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // A failed cleanup must not turn a completed ingest into an exception.
    }
  }
}
