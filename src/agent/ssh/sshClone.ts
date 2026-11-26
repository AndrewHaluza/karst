import type { PipeEnd } from '../docker/dockerProcess.js';
import type { CloneInput, StepResult } from '../docker/dockerClone.js';
import {
  BASE_REF_PREFIX,
  HOST_AHEAD_MARKER,
  REFRESH_DIRTY,
  REFRESH_SCRIPT,
  STASH_REFRESH_SCRIPT,
  hostBaseRef,
  isSafeBaseRef,
  refreshArgs,
  refreshOutcome,
} from '../cloneRefresh.js';
import { THIN_BUNDLE_EXCLUDE, hostBundleHaves, sandboxHeadRef } from '../cloneSyncClass.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { DiffResult, RefreshOptions, StepOutcome, SyncResult } from '../sessionRunner.js';
import type { SbxProcess } from '../sbx/sbxProcess.js';
import {
  SSH_BUNDLE_STDOUT_MAX_BYTES,
  SSH_TEXT_STDOUT_MAX_BYTES,
  diffSandboxBundle,
  fetchSandboxBundle,
  hostGit,
  syncSandboxBundle,
} from './sshCloneShared.js';
import { sshArgv, type SshProcess, type SshResult } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The git bundle transport of an SSH remote (D554, Part C), mirroring
 * `docker/dockerClone.ts` under the same rules (`@arch:AC-39` (5),
 * `@arch:AC-46`): git moves only as bundles, never as a `push`/`fetch` to a
 * checked-out remote tree, and the host only ever runs `git fetch` of a
 * bundle plus `merge --ff-only`. Host git never runs inside the remote clone,
 * and remote git never reads a host path.
 *
 * Every remote command is ONE string under `sh` (the remote login shell can be
 * fish or csh), built only from `sshQuote`d parts and fixed literals. Every
 * remote `mktemp` sets `trap 'rm -f "$tmp"' EXIT` so a full-history bundle
 * never piles up in the remote temp dir.
 */

export interface SshCloneContext {
  readonly ssh: SshProcess;
  /** The ssh executable for `pipe` (the seam's `pipe` spawns both sides); `SSH_BIN` in production, the fake in tests. */
  readonly sshBin: string;
  /** Host-side git; every call carries `-C <hostWorktreePath>`. */
  readonly host: SbxProcess;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh <name>: ...`). */
  readonly remoteName: string;
  /** `<remoteDir>/<sandboxName>/` is this ticket's remote workspace. */
  readonly sandboxName: string;
  /** The checked, 0700 ControlMaster dir from Part A (`/tmp/karst-ssh-<uid>/`). */
  readonly controlDir: string;
  readonly debug?: (message: string) => void;
}

/** The per-ticket remote workspace and the four dirs D555 expects. */
export interface SshRemotePaths {
  readonly workspace: string;
  readonly repo: string;
  readonly bridge: string;
  readonly env: string;
  readonly gates: string;
}

/** `<remoteDir>/<sandboxName>/repo|bridge|env|gates`; no trailing slash on `remoteDir` matters. */
export function sshRemotePaths(ctx: SshCloneContext): SshRemotePaths {
  const workspace = `${ctx.remote.remoteDir.replace(/\/+$/, '')}/${ctx.sandboxName}`;
  return {
    workspace,
    repo: `${workspace}/repo`,
    bridge: `${workspace}/bridge`,
    env: `${workspace}/env`,
    gates: `${workspace}/gates`,
  };
}

/** A fresh clone shows an `.invalid` HEAD briefly (T897), so readiness is polled, not judged once. */
export const SSH_CLONE_READY_TIMEOUT_MS = 30_000;
export const SSH_CLONE_READY_INTERVAL_MS = 1_000;

/** Exit code the readiness script uses for "the ticket branch does not resolve", so other failures are not misread as empty. */
const CLONE_EMPTY_EXIT = 74;

export interface SshCloneReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SHA = /^[0-9a-f]{40,64}$/;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last non-empty line of stderr (the actionable one), capped like `detail` in dockerClone. */
function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 200);
}

function remoteArgv(ctx: SshCloneContext, script: string): string[] {
  return sshArgv(ctx.remote, ctx.controlDir, script);
}

/** Every remote stdout is collected in memory, so every call is bounded (a bundle by its own, larger cap). */
function runRemote(ctx: SshCloneContext, script: string, maxStdoutBytes: number = SSH_TEXT_STDOUT_MAX_BYTES): Promise<SshResult> {
  return ctx.ssh.run(remoteArgv(ctx, script), { maxStdoutBytes });
}

interface RemoteFailure {
  readonly ok: false;
  readonly reason: string;
}

/** A non-zero result, mapped to a reason that names the remote and the step. Transport (255) is its own case. */
function remoteFailure(ctx: SshCloneContext, result: SshResult, step: string): RemoteFailure | undefined {
  if (result.transport === true || result.code === 255) {
    const t = tail(result.stderr);
    return { ok: false, reason: `ssh ${ctx.remoteName}: transport failed during ${step}${t === '' ? '' : `: ${t}`}` };
  }
  if (result.code !== 0) {
    const t = tail(result.stderr);
    return { ok: false, reason: `ssh ${ctx.remoteName}: ${step} failed${t === '' ? ` (exit ${String(result.code)})` : `: ${t}`}` };
  }
  return undefined;
}

/** The trap line every remote temp file carries. `-p` keeps a full bundle inside the private workspace, never the shared temp dir. */
function tempLine(paths: SshRemotePaths): string {
  return `tmp=$(mktemp -p ${sshQuote(paths.workspace)}) && trap 'rm -f "$tmp"' EXIT || exit 1`;
}

function mkdirLine(paths: SshRemotePaths): string {
  return `mkdir -p -m 0700 ${[paths.workspace, paths.repo, paths.bridge, paths.env, paths.gates].map(sshQuote).join(' ')}`;
}

async function hostIdentity(ctx: SshCloneContext, input: CloneInput): Promise<{ name: string; email: string }> {
  const name = (await hostGit(ctx.host, input, ['config', 'user.name'])).stdout.trim();
  const email = (await hostGit(ctx.host, input, ['config', 'user.email'])).stdout.trim();
  return { name, email };
}

/**
 * Best effort, like dockerClone: a base ref that cannot be fetched is simply
 * not bundled, and the clone starts without a merge base. An invalid ref name
 * is dropped rather than reaching git.
 *
 * The bundled host ref is `refs/remotes/origin/<base>` (`hostBaseRef`), the ref
 * that exists in the host worktree; `refs/karst/base/<base>` is the CLONE-side
 * name the remote pins after the clone (mirroring dockerClone). Bundling the
 * clone-side name on the host would name a ref the host does not have.
 */
async function bestEffortBase(ctx: SshCloneContext, input: CloneInput): Promise<string | undefined> {
  const base = input.baseRef;
  if (base === undefined || !isSafeBaseRef(base)) return undefined;
  const fetched = await hostGit(ctx.host, input, ['fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
  if (fetched.code !== 0) return undefined;
  return (await hostGit(ctx.host, input, ['rev-parse', '--verify', '--quiet', hostBaseRef(base)])).code === 0 ? base : undefined;
}

/** `<remoteDir>/<sandboxName>/…` exist 0700 and `refs/heads/<branch>` resolves → already cloned (no-op). */
function probeScript(ctx: SshCloneContext, input: CloneInput): string {
  const paths = sshRemotePaths(ctx);
  return [
    '# karst-ssh-clone-probe',
    mkdirLine(paths),
    `git -C ${sshQuote(paths.repo)} rev-parse --verify --quiet ${sshQuote(`refs/heads/${input.branch}^{commit}`)} >/dev/null`,
  ].join('\n');
}

function ensureScript(
  ctx: SshCloneContext,
  input: CloneInput,
  identity: { name: string; email: string },
  base: string | undefined,
): string {
  const paths = sshRemotePaths(ctx);
  const repo = sshQuote(paths.repo);
  return [
    'set -e',
    mkdirLine(paths),
    tempLine(paths),
    'cat > "$tmp"',
    `git clone --no-hardlinks --branch ${sshQuote(input.branch)} "$tmp" ${repo}`,
    `git -C ${repo} remote remove origin`,
    ...(identity.name === '' ? [] : [`git -C ${repo} config user.name ${sshQuote(identity.name)}`]),
    ...(identity.email === '' ? [] : [`git -C ${repo} config user.email ${sshQuote(identity.email)}`]),
    ...(base === undefined
      ? []
      : [`git -C ${repo} fetch -q "$tmp" ${sshQuote(`+${hostBaseRef(base)}:${BASE_REF_PREFIX}${base}`)}`]),
  ].join('\n');
}

function hostBundleArgs(input: CloneInput, base: string | undefined): string[] {
  return ['-C', input.hostWorktreePath, 'bundle', 'create', '-', input.branch, ...(base === undefined ? [] : [hostBaseRef(base)])];
}

function pipeFailure(ctx: SshCloneContext, branch: string, fromCode: number, toCode: number, step: string): StepResult | undefined {
  if (fromCode !== 0) return { ok: false, reason: `ssh ${ctx.remoteName}: git bundle create ${branch} failed (exit ${String(fromCode)})` };
  if (toCode === 255) return { ok: false, reason: `ssh ${ctx.remoteName}: transport failed during ${step}` };
  if (toCode !== 0) return { ok: false, reason: `ssh ${ctx.remoteName}: ${step} failed (exit ${String(toCode)})` };
  return undefined;
}

/**
 * Seed the remote clone from a host bundle streamed over the ssh pipe.
 * Idempotent: a clone that already has the branch is a no-op, so a relaunch
 * never disturbs the agent's work.
 */
export async function ensureSshClone(ctx: SshCloneContext, input: CloneInput): Promise<StepResult> {
  try {
    const probe = await runRemote(ctx, probeScript(ctx, input));
    if (probe.transport === true || probe.code === 255) return remoteFailure(ctx, probe, 'clone probe')!;
    if (probe.code === 0) return { ok: true };
    const base = await bestEffortBase(ctx, input);
    const identity = await hostIdentity(ctx, input);
    const to: PipeEnd = { command: ctx.sshBin, args: remoteArgv(ctx, ensureScript(ctx, input, identity, base)) };
    const piped = await ctx.ssh.pipe({ command: 'git', args: hostBundleArgs(input, base) }, to);
    return pipeFailure(ctx, input.branch, piped.fromCode, piped.toCode, `clone of ${input.branch}`) ?? { ok: true };
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: clone failed: ${message(err)}` };
  }
}

function thinScript(ctx: SshCloneContext, input: CloneInput, haves: readonly string[]): string {
  const paths = sshRemotePaths(ctx);
  return [
    '# karst-ssh-thin-bundle',
    'set -e',
    haves.length === 0 ? 'set --' : `set -- ${haves.map(sshQuote).join(' ')}`,
    // A function, not a string: the path stays quoted for every `$g ...` call (a stored `'path'` would keep its quotes).
    // `g=g` is the variable THIN_BUNDLE_EXCLUDE expands; it names the function.
    `g() { git -C ${sshQuote(paths.repo)} "$@"; }`,
    'g=g',
    `br=${sshQuote(input.branch)}`,
    THIN_BUNDLE_EXCLUDE,
    '$g bundle create -q - "$br" $ex',
  ].join('\n');
}

type RemoteBundle = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

/** Run the thin-bundle script on the clone and return its stdout bytes (never a JS string). */
async function remoteBundle(ctx: SshCloneContext, input: CloneInput): Promise<RemoteBundle> {
  const haves = await hostBundleHaves((args) => hostGit(ctx.host, input, args), input.branch);
  const result = await runRemote(ctx, thinScript(ctx, input, haves), SSH_BUNDLE_STDOUT_MAX_BYTES);
  const failed = remoteFailure(ctx, result, 'sync bundle');
  if (failed !== undefined) return { ok: false, reason: failed.reason };
  return { ok: true, bytes: result.stdoutBuffer };
}

/** The clone's commits → the host branch: thin bundle out, hardened fetch, resolve once, `merge --ff-only`. */
export async function syncFromSshClone(ctx: SshCloneContext, input: CloneInput): Promise<SyncResult> {
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await syncSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: sync failed: ${message(err)}` };
  }
}

/** Fetch the clone's branch into `refs/karst/sandbox/<branch>` and stop; nothing is merged. */
export async function fetchSshClone(ctx: SshCloneContext, input: CloneInput): Promise<StepResult> {
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await fetchSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: fetch failed: ${message(err)}` };
  }
}

/** What a sync would bring in, as a diff against the host branch; nothing is merged. */
export async function diffSshClone(ctx: SshCloneContext, input: CloneInput): Promise<DiffResult> {
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await diffSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: diff failed: ${message(err)}` };
  }
}

function refreshScript(ctx: SshCloneContext, input: CloneInput, opts: RefreshOptions | undefined): string {
  const paths = sshRemotePaths(ctx);
  const script = opts?.stashMessage === undefined ? REFRESH_SCRIPT : STASH_REFRESH_SCRIPT;
  // `refreshArgs` puts the bundle path at index 1; that one is the shell variable, not a quoted literal.
  const args = refreshArgs(input.branch, '$tmp', opts);
  const setArgs = args.map((arg, i) => (i === 1 ? '"$tmp"' : sshQuote(arg))).join(' ');
  return [
    `cd ${sshQuote(paths.repo)} || exit 1`,
    tempLine(paths),
    'cat > "$tmp" || exit 1',
    `set -- ${setArgs}`,
    script,
  ].join('\n');
}

/** Re-read the refusal after a dirty refresh (the pipe dropped the script's stdout), with the same marker `refreshOutcome` parses. */
function dirtyDiffScript(ctx: SshCloneContext): string {
  const paths = sshRemotePaths(ctx);
  return [
    '# karst-ssh-refresh-diff',
    `cd ${sshQuote(paths.repo)} || exit 1`,
    'if [ -n "$(git status --porcelain)" ]; then',
    `echo "${HOST_AHEAD_MARKER} $(git rev-list --count HEAD..FETCH_HEAD 2>/dev/null)"`,
    'git status --short',
    'git diff HEAD | head -c 20000',
    'fi',
  ].join('\n');
}

function withRemote(ctx: SshCloneContext, reason: string): { ok: false; reason: string } {
  return { ok: false, reason: `ssh ${ctx.remoteName}: ${reason}` };
}

/**
 * Host → clone (F8): bundle the host branch and stream it into the clone,
 * which fetches it and fast-forwards (`@arch:AC-46`). A dirty clone or a
 * divergence is refused, never forced. The base ref, when asked for, rides in
 * the same bundle and is force-updated as `refs/karst/base/<base>` before the
 * branch fetch, so `FETCH_HEAD` still carries the branch.
 */
export async function refreshSshClone(
  ctx: SshCloneContext,
  input: CloneInput,
  refreshOpts?: RefreshOptions,
): Promise<SyncResult> {
  try {
    const base = refreshOpts?.baseRef;
    if (base !== undefined && !isSafeBaseRef(base)) {
      return withRemote(ctx, `refusing to ship base ref ${JSON.stringify(base)}`);
    }
    if (base !== undefined) {
      const got = await hostGit(ctx.host, input, ['fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
      if (got.code !== 0) return withRemote(ctx, `git fetch origin ${base} failed: ${tail(got.stderr)}`);
    }
    const to: PipeEnd = { command: ctx.sshBin, args: remoteArgv(ctx, refreshScript(ctx, input, refreshOpts)) };
    const piped = await ctx.ssh.pipe({ command: 'git', args: hostBundleArgs(input, base) }, to);
    if (piped.fromCode !== 0) return withRemote(ctx, `git bundle create ${input.branch} failed (exit ${String(piped.fromCode)})`);
    if (piped.toCode === 255) return withRemote(ctx, 'transport failed during refresh');
    if (piped.toCode === REFRESH_DIRTY) {
      const diagnostic = await runRemote(ctx, dirtyDiffScript(ctx));
      const stdout = diagnostic.code === 0 ? diagnostic.stdout : '';
      const outcome = refreshOutcome(REFRESH_DIRTY, stdout, diagnostic.stderr, input.branch);
      return outcome.ok ? outcome : withRemote(ctx, outcome.reason);
    }
    const outcome = refreshOutcome(piped.toCode, '', '', input.branch);
    return outcome.ok ? { ok: true, summary: `refreshed the ssh clone of ${input.branch} on ${ctx.remoteName} from the host` } : withRemote(ctx, outcome.reason);
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: refresh failed: ${message(err)}` };
  }
}

function readyScript(ctx: SshCloneContext, branch: string): string {
  return [
    '# karst-ssh-clone-ready',
    `git -C ${sshQuote(sshRemotePaths(ctx).repo)} rev-parse --verify --quiet ${sshQuote(`refs/heads/${branch}^{commit}`)} >/dev/null || exit ${String(CLONE_EMPTY_EXIT)}`,
  ].join('\n');
}

/**
 * Poll until the remote clone's ticket branch resolves (`@arch:AC-37`). Only
 * the empty-clone exit blocks; any other ssh failure is left to the step that
 * follows, which already reports it (a transport failure is reported here).
 */
export async function sshCloneReady(
  ctx: SshCloneContext,
  branch: string,
  opts: SshCloneReadyOptions = {},
): Promise<StepOutcome> {
  const interval = opts.intervalMs ?? SSH_CLONE_READY_INTERVAL_MS;
  const attempts = Math.floor((opts.timeoutMs ?? SSH_CLONE_READY_TIMEOUT_MS) / interval) + 1;
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < attempts; i++) {
    const out = await runRemote(ctx, readyScript(ctx, branch));
    if (out.transport === true || out.code === 255) return remoteFailure(ctx, out, 'clone-ready poll')!;
    if (out.code !== CLONE_EMPTY_EXIT) return { ok: true };
    if (i < attempts - 1) await sleep(interval);
  }
  return { ok: false, reason: `ssh ${ctx.remoteName}: the remote clone is empty: rebuild it from the host branch` };
}

/**
 * May the remote clone be removed and rebuilt from the host branch without
 * losing work? Only when every commit any remote ref points at is already on
 * the host branch or on the sandbox sync ref, and the clone has no
 * uncommitted or untracked work. Anything unreadable refuses too.
 */
export async function rebuildSshCheck(ctx: SshCloneContext, input: CloneInput): Promise<StepOutcome> {
  try {
    const paths = sshRemotePaths(ctx);
    const listed = await runRemote(ctx, `# karst-ssh-rebuild-refs\ngit -C ${sshQuote(paths.repo)} for-each-ref --format='%(objectname)'`);
    const listedFailure = remoteFailure(ctx, listed, 'rebuild check');
    if (listedFailure !== undefined) return listedFailure;
    const dirty = await runRemote(ctx, `# karst-ssh-rebuild-dirty\ngit -C ${sshQuote(paths.repo)} status --porcelain`);
    const dirtyFailure = remoteFailure(ctx, dirty, 'rebuild check');
    if (dirtyFailure !== undefined) return dirtyFailure;
    if (dirty.stdout.trim() !== '') {
      return withRemote(ctx, 'the remote clone has uncommitted or untracked changes, so it was not rebuilt: commit or stash them first');
    }
    const shas = [...new Set(listed.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''))];
    const syncRef = sandboxHeadRef(input.branch);
    const syncRefPresent = (await hostGit(ctx.host, input, ['rev-parse', '--verify', '--quiet', `${syncRef}^{commit}`])).code === 0;
    for (const sha of shas) {
      if (!SHA.test(sha)) return withRemote(ctx, 'cannot verify the remote commits, so it was not rebuilt: unexpected ref output');
      const onHost = (await hostGit(ctx.host, input, ['merge-base', '--is-ancestor', sha, input.branch])).code === 0;
      const onSyncRef = !onHost && syncRefPresent
        && (await hostGit(ctx.host, input, ['merge-base', '--is-ancestor', sha, syncRef])).code === 0;
      if (!onHost && !onSyncRef) {
        return withRemote(ctx, `the remote clone holds commits (${sha.slice(0, 12)}) that are not on ${input.branch}, so it was not rebuilt: sync it first`);
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: rebuild check failed: ${message(err)}` };
  }
}
