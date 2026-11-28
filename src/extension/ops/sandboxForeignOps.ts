import type { RemoteDef } from '../../manifest/types.js';
import { listForeignRemoteDirs, removeForeignRemoteDir, type ForeignDir } from '../../agent/ssh/sshForeign.js';
import { sshControlDir } from '../../agent/ssh/sshControlDir.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { sshQuote } from '../../agent/ssh/sshQuote.js';
import type { Notify } from './notify.js';
import { CANCEL, type Choose } from './sandboxLifecycleOps.js';

/**
 * `karst.sandbox.cleanupForeignRemote` (D824, edit 13).
 *
 * A foreign workspace is a `karst-*` dir on a remote that does NOT carry this
 * install's prefix: another editor's globalStorage, a reset install, or another
 * machine. The command lists them (multi-select, nothing preselected), names
 * every path with its last commit and unmerged count, asks a SECOND time for a
 * dir with commits not in `refs/karst/base/*`, and a second time for a dir with
 * a live tmux session. Then it kills the session and deletes the exact path
 * through `removeForeignRemoteDir`; the D555 prefix-guarded dispose is never
 * used, because it refuses every foreign name by design.
 */

export const REMOVE_FOREIGN = 'Remove foreign workspaces';

/** One foreign workspace of the multi-select quick pick. `id` is `<remote>\0<name>`. */
export interface ForeignPickItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
}

interface SelectedForeign {
  readonly remote: string;
  readonly def: RemoteDef;
  readonly dir: ForeignDir;
}

/** The pick/confirm/notify seams; `extension.ts` binds them to VS Code, tests to recorders. */
export interface SandboxForeignDeps {
  readonly projectRoot: string;
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  readonly installId: () => string | undefined;
  /** The dir of `ssh-trust.json` (globalStorage). */
  readonly globalStorageDir: string;
  readonly ssh?: SshProcess;
  readonly controlDir?: string;
  /** Multi-select quick pick; `undefined` = dismissed. Nothing is preselected. */
  readonly pick: (items: readonly ForeignPickItem[], placeHolder: string) => Promise<readonly string[] | undefined>;
  readonly choose: Choose;
  readonly notify: Notify;
  readonly now?: () => number;
  readonly debug?: (message: string) => void;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function age(sizeKb: number): string {
  const mb = Math.round(sizeKb / 1024);
  return mb >= 1 ? `${String(mb)} MB` : `${String(sizeKb)} kB`;
}

function itemOf(s: SelectedForeign): ForeignPickItem {
  return {
    id: `${s.remote}\u0000${s.dir.name}`,
    label: `${s.remote}: ${s.dir.path}`,
    description: `last commit ${s.dir.lastCommit ?? 'none'} · ${plural(s.dir.unmergedCommits, 'commit', 'commits')} not in refs/karst/base/* · ${plural(s.dir.ageDays, 'day', 'days')} old · ${age(s.dir.sizeKb)}`,
    detail: s.dir.tmux ? 'a live tmux session uses it' : undefined,
  };
}

function pathLine(s: SelectedForeign): string {
  return `${s.dir.path} — last commit ${s.dir.lastCommit ?? 'none'}, ${plural(s.dir.unmergedCommits, 'commit', 'commits')} not in refs/karst/base/*`;
}

/**
 * List, confirm and remove foreign remote workspaces. Returns the number
 * removed. Never throws: a failed remote is reported per remote.
 */
export async function cleanupForeignRemoteOp(deps: SandboxForeignDeps): Promise<number> {
  const remotes = deps.remotes() ?? {};
  const installId = deps.installId();
  if (Object.keys(remotes).length === 0) {
    deps.notify.info('This project declares no ssh remotes.');
    return 0;
  }
  if (installId === undefined) {
    // An install id is what tells this install's workspaces from foreign ones.
    deps.notify.info('karst: the ssh install id is not available; no remote workspace can be classified.');
    return 0;
  }
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const controlDir = deps.controlDir ?? sshControlDir();
  const ctx = {
    controlDir, trustDir: deps.globalStorageDir, projectRoot: deps.projectRoot, installId,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.debug === undefined ? {} : { debug: deps.debug }),
  };
  const listings = await Promise.all(Object.entries(remotes).map(async ([remote, def]) => ({
    remote, def, listing: await listForeignRemoteDirs(ssh, remote, def, ctx),
  })));
  const found: SelectedForeign[] = [];
  for (const { remote, def, listing } of listings) {
    if (listing.error !== undefined) deps.notify.warn(`karst: ${listing.error}`);
    for (const dir of listing.dirs) found.push({ remote, def, dir });
  }
  if (found.length === 0) {
    deps.notify.info('No foreign remote workspace was found.');
    return 0;
  }
  const picked = await deps.pick(found.map(itemOf), 'Select foreign remote workspaces to remove');
  if (picked === undefined || picked.length === 0) return 0;
  const wanted = new Set(picked);
  const selected = found.filter((s) => wanted.has(`${s.remote}\u0000${s.dir.name}`));
  if (selected.length === 0) return 0;

  const first = [
    `Remove ${plural(selected.length, 'foreign remote workspace', 'foreign remote workspaces')}?`,
    ...selected.map(pathLine),
  ].join('\n');
  if ((await deps.choose(first, [REMOVE_FOREIGN, CANCEL])) !== REMOVE_FOREIGN) return 0;

  const unmerged = selected.filter((s) => s.dir.unmergedCommits > 0);
  if (unmerged.length > 0) {
    const second = [
      `${plural(unmerged.length, 'foreign workspace has', 'foreign workspaces have')} commits not in refs/karst/base/*, which the removal loses:`,
      ...unmerged.map((s) => `${s.dir.path} — ${plural(s.dir.unmergedCommits, 'commit', 'commits')}`),
    ].join('\n');
    if ((await deps.choose(second, [REMOVE_FOREIGN, CANCEL])) !== REMOVE_FOREIGN) return 0;
  }

  const live = selected.filter((s) => s.dir.tmux);
  if (live.length > 0) {
    const second = [
      `${plural(live.length, 'foreign workspace has', 'foreign workspaces have')} a live tmux session; removing it ends that session:`,
      ...live.map((s) => s.dir.path),
    ].join('\n');
    if ((await deps.choose(second, [REMOVE_FOREIGN, CANCEL])) !== REMOVE_FOREIGN) return 0;
  }

  let removed = 0;
  for (const s of selected) {
    // Kill first: a live session may keep writing into the clone being deleted.
    // Stryker disable next-line StringLiteral: equivalent, the exact-match prefix only narrows the target
    await ssh.run(sshArgv(s.def, controlDir, `tmux kill-session -t ${sshQuote(`=${s.dir.name}`)} 2>/dev/null; exit 0`), { maxStdoutBytes: 1024 });
    const result = await removeForeignRemoteDir(ssh, s.remote, s.def, s.dir.name, true, ctx);
    if (result.ok) {
      removed += 1;
      deps.debug?.(`[ssh ${s.remote}] removed foreign workspace ${s.dir.path}`);
    } else {
      deps.notify.warn(`karst: the foreign remote workspace ${s.dir.path} was not removed: ${result.reason}`);
    }
  }
  deps.notify.info(`Removed ${plural(removed, 'foreign remote workspace', 'foreign remote workspaces')}.`);
  return removed;
}
