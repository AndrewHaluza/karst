import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where the per-ticket dir appears INSIDE the sandbox (arch:AC-34). */
export const SANDBOX_BRIDGE_MOUNT_ROOT = '/karst-bridge';

export interface BridgePaths {
  readonly dir: string;
  readonly eventsFile: string;
  readonly stateFile: string;
  readonly runDir: string;
}

export function bridgePaths(root: string, ticketId: number): BridgePaths {
  if (!Number.isInteger(ticketId) || ticketId < 0) throw new Error(`bridge: invalid ticket id ${ticketId}`);
  const dir = join(root, 'events', String(ticketId));
  return {
    dir,
    eventsFile: join(dir, 'events.ndjson'),
    stateFile: join(root, 'state', `${ticketId}.json`),
    runDir: `${SANDBOX_BRIDGE_MOUNT_ROOT}/${ticketId}`,
  };
}

/** The sandbox user is not the host user: the dir and file must be writable by it. Idempotent. */
export async function ensureBridgeDir(paths: BridgePaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o777 });
  await mkdir(dirname(paths.stateFile), { recursive: true });
  // 'a' never truncates: an existing log (a restart) is kept.
  await writeFile(paths.eventsFile, '', { flag: 'a', mode: 0o666 });
}

export async function removeBridgeDir(paths: BridgePaths): Promise<void> {
  await rm(paths.dir, { recursive: true, force: true });
  await rm(paths.stateFile, { force: true });
}

export async function listBridgeTicketIds(root: string): Promise<number[]> {
  let entries;
  try {
    entries = await readdir(join(root, 'events'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name));
}
