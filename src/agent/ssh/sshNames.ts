import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SSH_CORES, type SshCore } from '../sandboxCores.js';

/**
 * Remote sandbox names (D555, edit 2).
 *
 * The name carries ONLY the ticket and the core, so two hosts that use the
 * same absolute project path on ONE shared VM never collide: the hash input is
 * `projectRoot \0 installId`, and `installId` is a random id stored once per
 * karst install (`readOrCreateInstallId`), not a machine path.
 *
 * The name also names the remote workspace (`<remoteDir>/<name>`) and the tmux
 * session, and `dispose` deletes `<remoteDir>/<name>`: every consumer validates
 * it against `SANDBOX_NAME_RE` first, so a hand-written path can never widen
 * the delete.
 */

/** The exact shape of a remote sandbox name; `dispose` and `tmux -s` both refuse anything else. */
export const SANDBOX_NAME_RE = /^karst-[0-9a-f]{8}-[1-9][0-9]*-[a-z0-9]+$/;

/** `<globalStorage>/ssh/install-id`: one random id per karst install, reused forever. */
export const SSH_INSTALL_ID_FILE = 'ssh/install-id';

/** The per-install id shape (16 random bytes, hex). */
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The project's remote-name prefix, `karst-<sha256(projectRoot + '\0' + installId)[0..8]>`.
 * `sshSandboxName` appends `-<ticketId>-<core>`; `dispose` requires the name to
 * start with the same prefix.
 */
export function sshProjectPrefix(projectRoot: string, installId: string): string {
  const digest = createHash('sha256').update(`${projectRoot}\0${installId}`).digest('hex');
  return `karst-${digest.slice(0, 8)}`;
}

/**
 * The remote sandbox name: `karst-<hash8>-<ticketId>-<core>`. Throws for a core
 * outside `SSH_CORES` (an `agy` remote cannot exist, `@arch:AC-26`) and for a
 * ticket id that is not a positive integer, so `null` can never name an object
 * (`@arch:AC-39` (3)).
 */
export function sshSandboxName(
  projectRoot: string,
  installId: string,
  ticketId: number,
  core: SshCore,
): string {
  if (!(SSH_CORES as readonly string[]).includes(core)) {
    throw new Error(`ssh: core ${JSON.stringify(core)} cannot run on a remote`);
  }
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error(`ssh: invalid ticket id ${JSON.stringify(ticketId)}`);
  }
  return `${sshProjectPrefix(projectRoot, installId)}-${String(ticketId)}-${core}`;
}

export interface InstallIdDeps {
  /** Random id source (tests); defaults to 16 random bytes as hex. */
  readonly randomId?: () => string;
  /** Verbose logging; the value is never logged. Absent → silent. */
  readonly debug?: (message: string) => void;
}

function defaultRandomId(): string {
  return randomBytes(16).toString('hex');
}

/** The stored id, or `undefined` when the file is missing or holds no valid id. */
async function readInstallId(path: string, debug?: (message: string) => void): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debug?.(`[ssh] install id: cannot read ${path} (${describeError(error)})`);
    }
    return undefined;
  }
  const id = text.trim();
  if (!INSTALL_ID_RE.test(id)) {
    debug?.(`[ssh] install id: ${path} holds no valid id`);
    return undefined;
  }
  return id;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The per-install id at `<globalStorage>/ssh/install-id`, created ONCE (mode
 * 0600, `wx` so a concurrent creator wins the race and the loser reads its id)
 * and read back on every later call. Async fs only: this runs on the extension
 * host (`@arch:EVENTLOOP`).
 *
 * A directory or file karst cannot create or read fails closed with the path;
 * the caller maps that to a failed remote resolve.
 */
export async function readOrCreateInstallId(
  globalStorageDir: string,
  deps: InstallIdDeps = {},
): Promise<string> {
  const path = join(globalStorageDir, SSH_INSTALL_ID_FILE);
  const existing = await readInstallId(path, deps.debug);
  if (existing !== undefined) return existing;

  const id = (deps.randomId ?? defaultRandomId)();
  if (!INSTALL_ID_RE.test(id)) throw new Error(`ssh: invalid install id ${JSON.stringify(id)}`);
  await mkdir(join(globalStorageDir, 'ssh'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${id}\n`, { mode: 0o600, flag: 'wx' });
    deps.debug?.(`[ssh] install id: created ${path}`);
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another launch created it in the race: its id is the install id.
    const raced = await readInstallId(path, deps.debug);
    if (raced === undefined) throw new Error(`ssh: install id file ${path} is not readable`);
    return raced;
  }
}
