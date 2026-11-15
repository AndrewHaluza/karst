import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const UPLOAD_ROOT = resolve('/srv/app/uploads');

/** Resolve a user supplied name inside the upload directory. */
export function resolveUpload(name: string): string {
  const full = resolve(UPLOAD_ROOT, name);
  if (!full.startsWith(UPLOAD_ROOT)) {
    throw new Error('path escapes the upload directory');
  }
  return full;
}

export async function readUpload(name: string): Promise<Buffer> {
  return readFile(resolveUpload(name));
}
