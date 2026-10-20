import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The host branch head after the last successful sync, per worktree (arch:AC-33).
 * Host-private: it sits in `<root>/state`, beside the poller offsets and OUTSIDE
 * the mounted events dir, so the agent can neither read nor forge it.
 */
export function hostHeadFileFor(bridgeDir: string): string {
  return join(dirname(dirname(bridgeDir)), 'state', `${basename(bridgeDir)}.host-head.json`);
}

async function readAll(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function recordHostHead(file: string, worktreePath: string, sha: string): Promise<void> {
  const next = { ...(await readAll(file)), [worktreePath]: sha };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next));
  await rename(tmp, file);
}

/** The recorded head, or undefined when none was recorded (or the record is unusable). */
export async function readHostHead(file: string, worktreePath: string): Promise<string | undefined> {
  const value = (await readAll(file))[worktreePath];
  return typeof value === 'string' && SHA.test(value) ? value : undefined;
}
