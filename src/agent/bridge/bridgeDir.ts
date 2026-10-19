import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HookChannel } from '../adapter.js';

const EVENTS_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/** Where the per-ticket dir appears INSIDE the sandbox (arch:AC-34). */
export const SANDBOX_BRIDGE_MOUNT_ROOT = '/karst-bridge';

export interface BridgePaths {
  readonly dir: string;
  readonly eventsFile: string;
  readonly stateFile: string;
  /** Host-written reply files, one per marker line (arch:AC-34); the host never reads them back. */
  readonly resultsDir: string;
  /** Host-private retry record for a marker that failed transiently (outside the sandbox-writable dir). */
  readonly pendingFile: string;
  readonly runDir: string;
}

export function bridgePaths(root: string, ticketId: number): BridgePaths {
  if (!Number.isInteger(ticketId) || ticketId < 0) throw new Error(`bridge: invalid ticket id ${ticketId}`);
  const dir = join(root, 'events', String(ticketId));
  return {
    dir,
    eventsFile: join(dir, 'events.ndjson'),
    stateFile: join(root, 'state', `${ticketId}.json`),
    resultsDir: join(dir, 'results'),
    pendingFile: join(root, 'state', `${ticketId}.marker.json`),
    runDir: `${SANDBOX_BRIDGE_MOUNT_ROOT}/${ticketId}`,
  };
}

/**
 * The FILE hook channel for a sandboxed launch: scripts are written to the
 * host bridge dir, the agent appends to `<runDir>/events.ndjson` as it sees it.
 * `runDir` comes from the runner (`SessionRunner.bridgeRunDir`).
 */
export function sandboxHookChannel(paths: BridgePaths, launchId: string | undefined, runDir: string): HookChannel {
  return {
    endpointUrl: `file://${runDir}/events.ndjson`,
    configDir: paths.dir,
    runDir,
    ...(launchId !== undefined ? { launchId } : {}),
  };
}

/** The sandbox user is not the host user: the dir and file must be writable by it. Idempotent. */
export async function ensureBridgeDir(paths: BridgePaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o777 });
  await mkdir(dirname(paths.stateFile), { recursive: true });
  await prepareEventsFile(paths.eventsFile);
  // The host writes replies here; the sandbox only reads them.
  await mkdir(paths.resultsDir, { recursive: true, mode: 0o755 });
  // mode is masked by umask: enforce explicitly.
  // Sticky: another sandbox user cannot rename or replace the host-owned results dir.
  await chmod(paths.dir, 0o1777);
}

/**
 * Opens without following symlinks or blocking on FIFOs, then chmods through the
 * handle so a planted symlink can never make a host file writable. Never truncates.
 */
async function prepareEventsFile(file: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(file, EVENTS_FLAGS, 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`bridge: refusing symlinked events file ${file}`);
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`bridge: events file is not a regular file: ${file}`);
    await handle.chmod(0o666);
  } finally {
    await handle.close();
  }
}

export async function removeBridgeDir(paths: BridgePaths): Promise<void> {
  await rm(paths.dir, { recursive: true, force: true });
  await rm(paths.stateFile, { force: true });
  await rm(paths.pendingFile, { force: true });
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
