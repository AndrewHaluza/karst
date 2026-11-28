import type { RemoteDef } from '../../manifest/types.js';
import { SANDBOX_NAME_RE, sshProjectPrefix } from './sshNames.js';
import { remoteDirIsSafe } from './sshDisposeGuard.js';
import { isRemoteTrusted, readRemoteTrust } from './remoteTrust.js';
import { sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * Foreign remote workspaces (D824, edit 13).
 *
 * Every workspace on a remote is named `karst-<hash8>-<ticket>-<core>`, and the
 * hash is `projectRoot + installId`. So a dir that starts with `karst-` but NOT
 * with THIS install's prefix belongs to another editor (Cursor and VS Code have
 * their own globalStorage), a reset globalStorage, or another machine. The D555
 * `dispose` guard refuses those names by design, so removing one needs its own
 * guarded path: `removeForeignRemoteDir`.
 *
 * Trust first (D553 C1): an unconfirmed remote gets no ssh call, for the listing
 * and for the delete. Every remote argument is `sshQuote`d.
 */

/** The per-remote listing bound: a hung VM never holds the command. */
export const FOREIGN_LIST_TIMEOUT_MS = 20_000;
/** The listing is one `printf` per dir; anything larger is a broken remote. */
const FOREIGN_LIST_STDOUT_BYTES = 256 * 1024;

export interface ForeignDir {
  readonly name: string;
  /** `<remoteDir>/<name>`. */
  readonly path: string;
  /** Whole days since the dir's mtime. */
  readonly ageDays: number;
  readonly sizeKb: number;
  /** `%cI` of the clone's HEAD; `null` when there is no clone. */
  readonly lastCommit: string | null;
  /** `git rev-list --count HEAD --not --glob=refs/karst/base/*`; 0 when there is no clone; `null` (unknown) when git fails on the clone. */
  readonly unmergedCommits: number | null;
  /** A live tmux session of that name (the second modal the command needs). */
  readonly tmux: boolean;
}

export interface ForeignListing {
  readonly dirs: readonly ForeignDir[];
  /** `ssh <remote>: <reason>`; the remote is unknown, never "no foreign dirs". */
  readonly error?: string;
}

export interface ForeignContext {
  /** The checked ControlMaster dir (D554). */
  readonly controlDir: string;
  /** The dir of `ssh-trust.json` (globalStorage). */
  readonly trustDir: string;
  readonly projectRoot: string;
  readonly installId: string;
  /** Clock for the age of a dir (tests pin it). */
  readonly now?: () => number;
  readonly debug?: (message: string) => void;
}

export type ForeignRemoveContext = ForeignContext;

export type ForeignRemoveResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function notConfirmed(remote: string): string {
  return `ssh ${remote}: ssh remote ${remote} not confirmed`;
}

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/** The remote dir without a trailing slash: `<remoteDir>/<name>` must be exact. */
export function remoteDirOf(def: RemoteDef): string {
  return def.remoteDir.replace(/\/+$/, '');
}

/** The foreign prefix of a name: `karst-` instead of this install's `karst-<hash8>-`. */
export function isForeignName(name: string, projectRoot: string, installId: string): boolean {
  return name.startsWith('karst-') && !name.startsWith(`${sshProjectPrefix(projectRoot, installId)}-`);
}

/**
 * ONE remote call lists every `karst-*` dir with its mtime, `du -sk`, last
 * commit, the commits not in a `refs/karst/base/*` ref and its tmux state.
 * A missing clone prints `-` and `0`, so a dir with no clone needs no second
 * confirm.
 */
export function foreignListScript(remoteDir: string): string {
  return [
    '# karst-ssh-foreign-list',
    `d=${sshQuote(remoteDir.replace(/\/+$/, ''))}`,
    'ls -1 "$d" 2>/dev/null | while IFS= read -r n; do',
    '  case "$n" in karst-*) ;; *) continue ;; esac',
    '  p="$d/$n"',
    '  [ -d "$p" ] || continue',
    '  m=$(stat -c %Y "$p" 2>/dev/null || echo 0)',
    '  k=$(du -sk "$p" 2>/dev/null | awk \'NR == 1 { print $1 }\')',
    '  l=$(git -C "$p/repo" log -1 --format=%cI 2>/dev/null || true)',
    // 0 only with no clone: a clone that git cannot read is `?` (unknown), so the removal still asks the second confirm.
    `  if [ -d "$p/repo" ]; then c=$(git -C "$p/repo" rev-list --count HEAD --not ${sshQuote('--glob=refs/karst/base/*')} 2>/dev/null || echo '?'); else c=0; fi`,
    '  t=$(tmux has-session -t "=$n" 2>/dev/null && echo yes || echo no)',
    '  printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$n" "$m" "$k" "$l" "$c" "$t"',
    'done',
    'exit 0',
  ].join('\n');
}

function int(text: string): number {
  return count(text) ?? 0;
}

/** A non-negative integer, or `null` for any other text (a failed probe). */
function count(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** `name\tmtime\tkb\tlastCommit\tunmerged\ttmux` lines; an unparsable line is skipped. */
export function parseForeignListing(stdout: string, def: RemoteDef, nowMs: number): ForeignDir[] {
  const dir = remoteDirOf(def);
  const out: ForeignDir[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const [name, mtime, kb, last, unmerged, tmux] = line.split('\t');
    if (name === undefined || !name.startsWith('karst-')) continue;
    const lastCommit = last === undefined || last === '' || last === '-' ? null : last;
    out.push({
      name,
      path: `${dir}/${name}`,
      ageDays: Math.max(0, Math.floor((nowMs / 1000 - int(mtime ?? '0')) / 86_400)),
      sizeKb: int(kb ?? '0'),
      lastCommit,
      unmergedCommits: count(unmerged ?? ''),
      tmux: tmux !== undefined && tmux.trim() === 'yes',
    });
  }
  return out;
}

/** The foreign `karst-*` dirs of one remote, or the reason it cannot be listed. No ssh for an unconfirmed remote. */
export async function listForeignRemoteDirs(
  ssh: SshProcess,
  remote: string,
  def: RemoteDef,
  ctx: ForeignContext,
): Promise<ForeignListing> {
  const trust = readRemoteTrust(ctx.trustDir);
  // Trust first (D553 C1): an unconfirmed remote gets no ssh call at all.
  if (!isRemoteTrusted(trust, remote, def)) return { dirs: [], error: notConfirmed(remote) };
  if (!remoteDirIsSafe(def.remoteDir)) {
    return { dirs: [], error: `ssh ${remote}: refused remoteDir ${JSON.stringify(def.remoteDir)}` };
  }
  const out = await ssh.run(sshArgv(def, ctx.controlDir, foreignListScript(def.remoteDir)), {
    maxStdoutBytes: FOREIGN_LIST_STDOUT_BYTES,
    signal: AbortSignal.timeout(FOREIGN_LIST_TIMEOUT_MS),
  });
  if (out.transport === true) return { dirs: [], error: `ssh ${remote}: transport failed: ${tail(out.stderr)}` };
  if (out.code !== 0) {
    return { dirs: [], error: `ssh ${remote}: foreign listing failed (exit ${String(out.code)})${tail(out.stderr) === '' ? '' : `: ${tail(out.stderr)}`}` };
  }
  const prefix = sshProjectPrefix(ctx.projectRoot, ctx.installId);
  const now = (ctx.now ?? Date.now)();
  const dirs = parseForeignListing(out.stdout, def, now).filter((d) => isForeignName(d.name, ctx.projectRoot, ctx.installId));
  ctx.debug?.(`[ssh ${remote}] foreign listing: ${String(dirs.length)} dir(s) outside ${prefix}-`);
  return { dirs };
}

/** Exit code the remove script uses for "the name is no longer in the fresh listing". */
const FOREIGN_NOT_LISTED_EXIT = 3;
/** Exit code the remove script uses for "the remote dir is gone". */
const FOREIGN_NO_DIR_EXIT = 2;

/**
 * One remote call that first re-lists `<remoteDir>` and only then deletes, so a
 * name that vanished (another editor cleaned it) deletes nothing. Every guard
 * runs before the call; the remote re-checks the name in the same round trip.
 */
export async function removeForeignRemoteDir(
  ssh: SshProcess,
  remote: string,
  def: RemoteDef,
  name: string,
  confirmed: boolean,
  ctx: ForeignRemoveContext,
): Promise<ForeignRemoveResult> {
  if (!isRemoteTrusted(readRemoteTrust(ctx.trustDir), remote, def)) return { ok: false, reason: notConfirmed(remote) };
  if (confirmed !== true) return { ok: false, reason: `ssh ${remote}: foreign removal of ${JSON.stringify(name)} not confirmed by the user` };
  // The D553 rule already means: absolute, 2+ segments, no empty/./.. segment.
  if (!remoteDirIsSafe(def.remoteDir)) {
    return { ok: false, reason: `ssh ${remote}: refused remoteDir ${JSON.stringify(def.remoteDir)} (not an absolute path of 2+ plain segments)` };
  }
  if (name.includes('/') || name === '.' || name === '..' || !SANDBOX_NAME_RE.test(name)) {
    return { ok: false, reason: `ssh ${remote}: refused name ${JSON.stringify(name)} (not a sandbox name)` };
  }
  if (name.startsWith(`${sshProjectPrefix(ctx.projectRoot, ctx.installId)}-`)) {
    return { ok: false, reason: `ssh ${remote}: refused name ${JSON.stringify(name)} (not foreign: use the normal dispose)` };
  }
  const dir = remoteDirOf(def);
  const path = `${dir}/${name}`;
  // Exact path: the caller's name is one validated segment of `<remoteDir>`.
  if (!path.startsWith(`${dir}/`) || path === `${dir}/`) {
    return { ok: false, reason: `ssh ${remote}: refused path ${JSON.stringify(path)}` };
  }
  const script = [
    '# karst-ssh-foreign-remove',
    `[ -d ${sshQuote(dir)} ] || exit ${String(FOREIGN_NO_DIR_EXIT)}`,
    `ls -1 ${sshQuote(dir)} | grep -Fqx ${sshQuote(name)} || exit ${String(FOREIGN_NOT_LISTED_EXIT)}`,
    `rm -rf -- ${sshQuote(path)}`,
  ].join('\n');
  const out = await ssh.run(sshArgv(def, ctx.controlDir, script), { maxStdoutBytes: 1024, signal: AbortSignal.timeout(FOREIGN_LIST_TIMEOUT_MS) });
  if (out.transport === true) return { ok: false, reason: `ssh ${remote}: transport failed: ${tail(out.stderr)}` };
  if (out.code === FOREIGN_NOT_LISTED_EXIT) return { ok: false, reason: `ssh ${remote}: ${name} is not in the fresh listing of ${dir}` };
  if (out.code === FOREIGN_NO_DIR_EXIT) return { ok: false, reason: `ssh ${remote}: remote dir ${dir} is missing` };
  if (out.code !== 0) return { ok: false, reason: `ssh ${remote}: foreign removal failed (exit ${String(out.code)})${tail(out.stderr) === '' ? '' : `: ${tail(out.stderr)}`}` };
  ctx.debug?.(`[ssh ${remote}] foreign removal: ${path}`);
  return { ok: true };
}
