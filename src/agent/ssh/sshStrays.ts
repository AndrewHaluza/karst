import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The forgotten remote-workspace records (D824, edit 2).
 *
 * A ticket's "Forget remote workspace" (D830) leaves the remote dir alone and
 * writes one record here, beside `ssh-trust.json`, so the inventory can mark
 * that dir `stray: true`: no picker, lifecycle stop or removal ever touches it
 * again until the user deletes it through the strays sweep.
 *
 * The read is at a trust boundary (a host-owned file, but a hand-edited or
 * half-written one must not authorize anything), so every entry is checked:
 * a missing file is `[]`, a corrupt one warns once and is `[]`.
 */

/** The sibling of `ssh-trust.json` in the globalStorage dir. */
export const SSH_STRAYS_FILE = 'ssh-strays.json';

/** One forgotten remote workspace: `path` is `<remoteDir>/<name>`. */
export interface SshStrayRecord {
  readonly remote: string;
  readonly path: string;
  readonly ticketId: number;
  /** ISO timestamp of the forget (D830 writes it; this module only reads). */
  readonly forgottenAt: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSshStray(value: unknown): value is SshStrayRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.remote === 'string' && r.remote !== '' &&
    typeof r.path === 'string' && r.path !== '' &&
    typeof r.ticketId === 'number' && Number.isInteger(r.ticketId) && r.ticketId >= 1 &&
    typeof r.forgottenAt === 'string' && r.forgottenAt !== ''
  );
}

/** The open records; a missing file is `[]`, a corrupt one warns and is `[]`. */
export function readSshStrays(dir: string, warn?: (message: string) => void): readonly SshStrayRecord[] {
  const file = join(dir, SSH_STRAYS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn?.(`ssh strays: cannot read ${file}: ${describe(err)}`);
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    // One bad entry makes the whole file untrustworthy: never act on half of it.
    if (!Array.isArray(parsed) || !parsed.every(isSshStray)) throw new Error('not an array of stray records');
    return parsed;
  } catch (err) {
    warn?.(`ssh strays: ignoring corrupt ${file}: ${describe(err)}`);
    return [];
  }
}
