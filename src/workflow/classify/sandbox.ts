import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run `fn` with an empty, private working directory, removed afterwards. The
 * classify and intent passes must not see a source tree: with `cwd: '.'` the
 * agent landed in whatever directory the extension host happened to run in.
 */
export async function withEmptyCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'karst-analysis-'));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
