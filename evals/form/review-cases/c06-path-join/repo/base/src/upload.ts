import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const UPLOAD_ROOT = '/srv/uploads';

export async function readUpload(name: string): Promise<Buffer> {
  return readFile(join(UPLOAD_ROOT, basename(name)));
}
