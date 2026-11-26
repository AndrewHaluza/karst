import { chmod, lstat, mkdir } from 'node:fs/promises';

/**
 * The ControlMaster socket directory (D554, Part A.2).
 *
 * It is `/tmp/karst-ssh-<uid>/`, NOT under `globalStorage`: the macOS
 * globalStorage path holds a space (`Application Support`), which `ControlPath`
 * cannot take, and the full socket path must stay under the 104-byte
 * `sun_path` limit (`/tmp/karst-ssh-<uid>/` plus a 40-char `%C` is ~60).
 *
 * The directory is 0700 and owned by us. sockets are shared by every window of
 * this user, so before each use it must be a real directory (no symlink),
 * owned by the current uid, mode 0700 — otherwise another local user could
 * plant a socket and take over the multiplexed connection. Any other state
 * fails closed with `ssh: control dir <path> is not private`.
 *
 * fs calls here are on a HOST path (never a remote-provided one), so
 * `src/agent/ssh/` is deliberately NOT in the `fsCalls.conformance` scope.
 */

export interface SshControlStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/** The fs and identity calls, injected so the unit test can use fakes. */
export interface SshControlDeps {
  readonly uid: number;
  lstat(path: string): Promise<SshControlStat>;
  mkdir(path: string, opts: { readonly recursive: true; readonly mode: number }): Promise<string | undefined>;
  chmod(path: string, mode: number): Promise<void>;
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

export const NODE_SSH_CONTROL_DEPS: SshControlDeps = {
  uid: currentUid(),
  lstat: (path) => lstat(path),
  mkdir: (path, opts) => mkdir(path, opts),
  chmod: (path, mode) => chmod(path, mode),
};

export type SshControlResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** `/tmp/karst-ssh-<uid>/`, with the trailing slash that `ControlPath` appends `%C` to. */
export function sshControlDir(uid: number = currentUid()): string {
  return `/tmp/karst-ssh-${String(uid)}/`;
}

/** `lstat`, with ENOENT (and any other failure) as `undefined`. */
async function statOrUndefined(deps: SshControlDeps, path: string): Promise<SshControlStat | undefined> {
  try {
    return await deps.lstat(path);
  } catch {
    return undefined;
  }
}

/** `/a/b/` → `/a/b`; the root `/` stays `/`. */
function withoutTrailingSlash(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed === '' ? dir : trimmed;
}

/** Real directory, no symlink, our uid: the ownership part of "private". */
function ownedDirectory(st: SshControlStat, uid: number): boolean {
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid;
}

/**
 * Create the control dir 0700 (when missing) and verify it is private. Returns
 * a reason instead of throwing, so a caller maps it straight into a failed
 * step; the reason is exactly `ssh: control dir <path> is not private`.
 */
export async function ensureSshControlDir(
  dir: string = sshControlDir(),
  deps: SshControlDeps = NODE_SSH_CONTROL_DEPS,
): Promise<SshControlResult> {
  const notPrivate: SshControlResult = { ok: false, reason: `ssh: control dir ${dir} is not private` };
  // `lstat("link/")` resolves the link, so a trailing slash would hide a planted
  // symlink. Every fs call uses the path without it; the reason keeps `dir`.
  const path = withoutTrailingSlash(dir);
  let st = await statOrUndefined(deps, path);
  if (st === undefined) {
    try {
      await deps.mkdir(path, { recursive: true, mode: 0o700 });
    } catch {
      // The check below reports a directory we could not create.
    }
    st = await statOrUndefined(deps, path);
    if (st === undefined) return notPrivate;
    // Verify before chmod: never chmod through a symlink another user planted.
    if (!ownedDirectory(st, deps.uid)) return notPrivate;
    if ((st.mode & 0o777) !== 0o700) {
      try {
        await deps.chmod(path, 0o700);
      } catch {
        return notPrivate;
      }
      st = await statOrUndefined(deps, path);
    }
  }
  if (st === undefined || !ownedDirectory(st, deps.uid) || (st.mode & 0o777) !== 0o700) return notPrivate;
  return { ok: true };
}
