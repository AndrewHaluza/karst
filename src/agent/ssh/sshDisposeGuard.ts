import { SANDBOX_NAME_RE } from './sshNames.js';

/**
 * The guard in front of the one `rm -rf` the ssh runner sends (D555, edit 6).
 *
 * `remoteDir` must pass the D553 manifest rule again (an absolute POSIX path
 * with at least two segments and no empty, `.` or `..` segment), and the name
 * must be ONE path segment of the exact sandbox-name shape that starts with
 * this project's prefix. The deleted path is then exactly `<remoteDir>/<name>`.
 * Anything else is refused, so a hand-edited manifest or a corrupt name can
 * never widen the delete to `/`, `/home` or another project's workspace.
 */

/** The D553 `remoteDir` character rule (`src/manifest/schema.ts`), repeated here: the guard does not trust the caller. */
const REMOTE_DIR_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

export type DisposeTarget = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

export function remoteDirIsSafe(remoteDir: string): boolean {
  if (!REMOTE_DIR_PATTERN.test(remoteDir)) return false;
  const segments = remoteDir.split('/').slice(1);
  return segments.length >= 2 && segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

export function disposeTarget(remoteDir: string, name: string, prefix: string): DisposeTarget {
  if (!remoteDirIsSafe(remoteDir)) {
    return { ok: false, reason: `ssh dispose: refused remoteDir ${JSON.stringify(remoteDir)} (not an absolute path of 2+ plain segments)` };
  }
  if (name.includes('/') || name === '.' || name === '..' || !SANDBOX_NAME_RE.test(name)) {
    return { ok: false, reason: `ssh dispose: refused name ${JSON.stringify(name)} (not a sandbox name)` };
  }
  if (!name.startsWith(`${prefix}-`)) {
    return { ok: false, reason: `ssh dispose: refused name ${JSON.stringify(name)} (outside this project's prefix)` };
  }
  return { ok: true, path: `${remoteDir}/${name}` };
}
