import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync, readSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BridgePaths } from './bridgeDir.js';

/**
 * Host files a sandboxed agent must read, mirrored into the bridge dir (arch:AC-34): the
 * events dir is the only extra mount. The dir is agent-writable, so the host only ever
 * writes (real dir, `O_NOFOLLOW|O_EXCL` temp + rename, links refused) and NEVER reads a
 * copy back. Synchronous like `inbox.ts`: the callers are synchronous seams.
 */
export const MIRROR_MAX_BYTES = 10 * 1024 * 1024;
export const MIRROR_KEEP_LOGS = 5;

export type MirrorOutcome = 'copied' | 'too-large' | 'refused';
export type MirrorKind = 'attachments' | 'logs';

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function isMirrorName(name: string): boolean {
  return NAME.test(name);
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

function ensureRealDir(dir: string): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try { st = lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    rmSync(dir, { recursive: true, force: true });
    st = undefined;
  }
  if (!st) mkdirSync(dir, { recursive: true, mode: 0o755 });
}

/** True while `<paths.dir>/<kind>` is still a real directory physically under the bridge dir (a planted link fails). */
function stillInside(paths: BridgePaths, kind: MirrorKind): boolean {
  try {
    const dir = join(paths.dir, kind);
    return !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === join(realpathSync(paths.dir), kind);
  } catch {
    return false;
  }
}

/** Copy one regular file `src` to `<dir>/<kind>/<name>`; never follows a link at either end. */
export function mirrorFile(paths: BridgePaths, kind: MirrorKind, name: string, src: string, maxBytes: number = MIRROR_MAX_BYTES): MirrorOutcome {
  if (!NAME.test(name)) return 'refused';
  let from: number;
  try {
    from = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return 'refused';
  }
  try {
    const st = fstatSync(from);
    if (!st.isFile()) return 'refused';
    if (st.size > maxBytes) return 'too-large';
    const dir = join(paths.dir, kind);
    ensureRealDir(dir);
    if (!stillInside(paths, kind)) return 'refused';
    // Content-addressed / run-unique names: a same-size entry is already mirrored (spares a re-copy per launch).
    const have = lstatOrUndefined(join(dir, name));
    if (have?.isFile() && have.size === st.size) return 'copied';
    const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
    const to = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (let n = readSync(from, buf, 0, buf.length, null); n > 0; n = readSync(from, buf, 0, buf.length, null)) writeSync(to, buf, 0, n);
    } finally {
      closeSync(to);
    }
    if (!stillInside(paths, kind)) {
      rmSync(temp, { force: true });
      return 'refused';
    }
    renameSync(temp, join(dir, name));
    return 'copied';
  } catch {
    return 'refused';
  } finally {
    closeSync(from);
  }
}

/** Unlink a file or link; a planted directory is removed only when empty. Never recurses, never follows. */
function removeEntry(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) rmSync(path, { recursive: false, force: true });
    else unlinkSync(path);
  } catch {
    // gone or not removable: advisory copies, best effort
  }
}

/** Remove every entry of `<dir>/<kind>` that is not in `keep` (dotfiles included). */
export function pruneMirror(paths: BridgePaths, kind: MirrorKind, keep: ReadonlySet<string>): void {
  const dir = join(paths.dir, kind);
  try {
    if (!stillInside(paths, kind)) return;
    for (const entry of readdirSync(dir)) if (!keep.has(entry)) removeEntry(join(dir, entry));
  } catch {
    // no dir yet: nothing to prune
  }
}

/** Keep only the `limit` most recently modified files of `<dir>/logs`. */
export function pruneOldLogs(paths: BridgePaths, limit: number = MIRROR_KEEP_LOGS): void {
  const dir = join(paths.dir, 'logs');
  try {
    if (!stillInside(paths, 'logs')) return;
    const entries = readdirSync(dir)
      .map((name) => ({ name, mtime: lstatSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    for (const e of entries.slice(limit)) removeEntry(join(dir, e.name));
  } catch {
    // no dir yet: nothing to prune
  }
}
