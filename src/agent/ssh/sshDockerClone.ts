import type { PipeEnd } from '../docker/dockerProcess.js';
import { THIN_OUT_SCRIPT, type CloneInput, type StepResult } from '../docker/dockerClone.js';
import { CONTAINER_REPO, CONTAINER_WORK } from '../docker/dockerRunArgs.js';
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
import { hostBundleHaves } from '../cloneSyncClass.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { DiffResult, RefreshOptions, SyncResult } from '../sessionRunner.js';
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
 * Docker-mode clone over an SSH remote (D554, Part D; D822 is the caller).
 *
 * `docker/dockerClone.ts` cannot drive a remote daemon: it runs host git through
 * `ctx.proc` and bind-mounts a host temp dir into the container. Here every
 * host-side git call runs LOCALLY in the host worktree, and the bundles cross
 * as bytes on stdin/stdout of `docker run -i` through `pipe`. No host path ever
 * reaches the remote container: the only mount is the named volume D822
 * supplies at `/work`, and both `image` and `volume` are validated against a
 * plain-name pattern before any spawn.
 *
 * The same rules as Part C (`@arch:AC-39` (5), `@arch:AC-46`): git moves only
 * as bundles, the host only ever fetches a bundle by explicit path and runs
 * `merge --ff-only`, and a divergence is refused, never forced. The host side
 * of the fetch/resolve/merge is `sshCloneShared.ts`; only how the thin bundle
 * bytes are produced differs (`THIN_OUT_SCRIPT` inside the helper container).
 * Every remote command is ONE string under `sh` (`remoteSh`), built from
 * `sshQuote`d parts and fixed literals.
 */

/** A docker image reference and a volume name both fit this; a leading `/` (a host path) never does. */
export const SSH_DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** The seed bundle inside the container's volume; it is removed by the script's EXIT trap. */
export const DOCKER_BUNDLE_IN = `${CONTAINER_WORK}/in.bundle`;

/** `git` in the helper container: the volume can be owned by another uid than the process (safe.directory). */
const GIT = `git -c ${sshQuote('safe.directory=*')}`;

export interface SshDockerCloneContext {
  readonly ssh: SshProcess;
  /** The ssh executable for `pipe` (the seam's `pipe` spawns both sides); `SSH_BIN` in production, the fake in tests. */
  readonly sshBin: string;
  /** Host-side git; every call carries `-C <hostWorktreePath>`. */
  readonly host: SbxProcess;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh <name>: ...`). */
  readonly remoteName: string;
  /** The checked, 0700 ControlMaster dir from Part A (`/tmp/karst-ssh-<uid>/`). */
  readonly controlDir: string;
  /** The helper image (D822). Validated before any spawn. */
  readonly image: string;
  /** The named volume mounted at `/work` (D822). Validated before any spawn; never a host path. */
  readonly volume: string;
  readonly debug?: (message: string) => void;
}

function nameError(kind: 'image' | 'volume', value: string): Error {
  return new Error(`refusing docker ${kind} ${JSON.stringify(value)}: it is not a plain ${kind} name`);
}

/**
 * The ssh argv of one helper container, in the D554 seam form: the hardened
 * ssh options, `--`, the destination, then ONE remote command (`remoteSh`)
 * whose payload is `docker run … sh -c <script>`. `image` and `volume` are
 * validated before the argv exists, so a bad value never reaches a spawn.
 */
export function sshDockerHelper(
  remote: RemoteDef,
  controlDir: string,
  image: string,
  volume: string,
  script: string,
): string[] {
  if (!SSH_DOCKER_NAME.test(image)) throw nameError('image', image);
  if (!SSH_DOCKER_NAME.test(volume)) throw nameError('volume', volume);
  const inner = [
    'docker', 'run', '--rm', '-i', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '-v', `${volume}:${CONTAINER_WORK}`, image,
    'sh', '-c', sshQuote(script),
  ].join(' ');
  return sshArgv(remote, controlDir, inner);
}

type NameProblem = { readonly ok: false; readonly reason: string };

/** Fail closed before any spawn: a host path can never be the image or the mount source. */
function nameProblem(ctx: SshDockerCloneContext): NameProblem | undefined {
  for (const [kind, value] of [['image', ctx.image], ['volume', ctx.volume]] as const) {
    if (!SSH_DOCKER_NAME.test(value)) {
      return { ok: false, reason: `ssh ${ctx.remoteName}: refusing docker ${kind} ${JSON.stringify(value)}: it is not a plain ${kind} name` };
    }
  }
  return undefined;
}

function remoteArgv(ctx: SshDockerCloneContext, script: string): string[] {
  return sshDockerHelper(ctx.remote, ctx.controlDir, ctx.image, ctx.volume, script);
}

/** Every remote stdout is collected in memory, so every call is bounded (a bundle by its own, larger cap). */
function runDocker(ctx: SshDockerCloneContext, script: string, maxStdoutBytes: number = SSH_TEXT_STDOUT_MAX_BYTES): Promise<SshResult> {
  return ctx.ssh.run(remoteArgv(ctx, script), { maxStdoutBytes });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last non-empty line of stderr (the actionable one), capped like `detail` in dockerClone. */
function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 200);
}

interface RemoteFailure {
  readonly ok: false;
  readonly reason: string;
}

/** A non-zero result, mapped to a reason that names the remote and the step. Exit 255 is its own case. */
function remoteFailure(ctx: SshDockerCloneContext, result: SshResult, step: string): RemoteFailure | undefined {
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

function withRemote(ctx: SshDockerCloneContext, reason: string): { ok: false; reason: string } {
  return { ok: false, reason: `ssh ${ctx.remoteName}: ${reason}` };
}

function pipeFailure(ctx: SshDockerCloneContext, branch: string, fromCode: number, toCode: number, step: string): StepResult | undefined {
  if (fromCode !== 0) return { ok: false, reason: `ssh ${ctx.remoteName}: git bundle create ${branch} failed (exit ${String(fromCode)})` };
  if (toCode === 255) return { ok: false, reason: `ssh ${ctx.remoteName}: transport failed during ${step}` };
  if (toCode !== 0) return { ok: false, reason: `ssh ${ctx.remoteName}: ${step} failed (exit ${String(toCode)})` };
  return undefined;
}

async function hostIdentity(ctx: SshDockerCloneContext, input: CloneInput): Promise<{ name: string; email: string }> {
  const name = (await hostGit(ctx.host, input, ['config', 'user.name'])).stdout.trim();
  const email = (await hostGit(ctx.host, input, ['config', 'user.email'])).stdout.trim();
  return { name, email };
}

/**
 * Best effort, like dockerClone: a base ref that cannot be fetched is simply
 * not bundled. The bundled host ref is `refs/remotes/origin/<base>` (the ref
 * the host worktree has); the clone pins it as `refs/karst/base/<base>`.
 */
async function bestEffortBase(ctx: SshDockerCloneContext, input: CloneInput): Promise<string | undefined> {
  const base = input.baseRef;
  if (base === undefined || !isSafeBaseRef(base)) return undefined;
  const fetched = await hostGit(ctx.host, input, ['fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
  if (fetched.code !== 0) return undefined;
  return (await hostGit(ctx.host, input, ['rev-parse', '--verify', '--quiet', hostBaseRef(base)])).code === 0 ? base : undefined;
}

/** `refs/heads/<branch>` resolves inside the container's volume → already cloned (no-op). */
function probeScript(branch: string): string {
  return [
    '# karst-ssh-docker-clone-probe',
    'set -e',
    `${GIT} -C ${sshQuote(CONTAINER_REPO)} rev-parse --verify --quiet ${sshQuote(`refs/heads/${branch}^{commit}`)} >/dev/null`,
  ].join('\n');
}

/** Read the seed bundle from stdin (`docker run -i`), clone it into the volume, strip origin, pin the base. */
function seedScript(input: CloneInput, identity: { name: string; email: string }, base: string | undefined): string {
  const repo = sshQuote(CONTAINER_REPO);
  const bundle = sshQuote(DOCKER_BUNDLE_IN);
  return [
    '# karst-ssh-docker-clone-seed',
    'set -e',
    `trap 'rm -f ${DOCKER_BUNDLE_IN}' EXIT`,
    `cat > ${bundle}`,
    `${GIT} clone --no-hardlinks --branch ${sshQuote(input.branch)} ${bundle} ${repo}`,
    `${GIT} -C ${repo} remote remove origin`,
    ...(identity.name === '' ? [] : [`${GIT} -C ${repo} config user.name ${sshQuote(identity.name)}`]),
    ...(identity.email === '' ? [] : [`${GIT} -C ${repo} config user.email ${sshQuote(identity.email)}`]),
    ...(base === undefined
      ? []
      : [`${GIT} -C ${repo} fetch -q ${bundle} ${sshQuote(`+${hostBaseRef(base)}:${BASE_REF_PREFIX}${base}`)}`]),
  ].join('\n');
}

function hostBundleArgs(input: CloneInput, base: string | undefined): string[] {
  return ['-C', input.hostWorktreePath, 'bundle', 'create', '-', input.branch, ...(base === undefined ? [] : [hostBaseRef(base)])];
}

/**
 * Seed the container's clone from a host bundle streamed over the ssh pipe.
 * Idempotent: a clone that already has the branch is a no-op. The bundle is
 * written inside the volume only and removed by the EXIT trap.
 */
export async function ensureSshDockerClone(ctx: SshDockerCloneContext, input: CloneInput): Promise<StepResult> {
  const bad = nameProblem(ctx);
  if (bad) return bad;
  try {
    const probe = await runDocker(ctx, probeScript(input.branch));
    if (probe.transport === true || probe.code === 255) return remoteFailure(ctx, probe, 'clone probe')!;
    if (probe.code === 0) return { ok: true };
    const base = await bestEffortBase(ctx, input);
    const identity = await hostIdentity(ctx, input);
    const to: PipeEnd = { command: ctx.sshBin, args: remoteArgv(ctx, seedScript(input, identity, base)) };
    const piped = await ctx.ssh.pipe({ command: 'git', args: hostBundleArgs(input, base) }, to);
    return pipeFailure(ctx, input.branch, piped.fromCode, piped.toCode, `clone of ${input.branch}`) ?? { ok: true };
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: clone failed: ${message(err)}` };
  }
}

/**
 * The helper builds a THIN bundle to stdout (`THIN_OUT_SCRIPT`, `out=-`); the
 * host commits it lacks ride as positional args. The volume keeps no temp
 * file: the bytes leave on stdout.
 */
function thinScript(branch: string, haves: readonly string[]): string {
  return [
    '# karst-ssh-docker-thin-bundle',
    `set -- - ${[branch, ...haves].map(sshQuote).join(' ')}`,
    THIN_OUT_SCRIPT,
  ].join('\n');
}

type RemoteBundle = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

/** Run the thin-bundle script in the helper and return its stdout bytes (never a JS string). */
async function remoteBundle(ctx: SshDockerCloneContext, input: CloneInput): Promise<RemoteBundle> {
  const haves = await hostBundleHaves((args) => hostGit(ctx.host, input, args), input.branch);
  const result = await runDocker(ctx, thinScript(input.branch, haves), SSH_BUNDLE_STDOUT_MAX_BYTES);
  const failed = remoteFailure(ctx, result, 'sync bundle');
  if (failed !== undefined) return { ok: false, reason: failed.reason };
  ctx.debug?.(`ssh docker clone: received a ${String(result.stdoutBuffer.length)}-byte bundle`);
  return { ok: true, bytes: result.stdoutBuffer };
}

/** The clone's commits → the host branch: thin bundle out of the helper, then the shared hardened fetch/merge. */
export async function syncFromSshDockerClone(ctx: SshDockerCloneContext, input: CloneInput): Promise<SyncResult> {
  const bad = nameProblem(ctx);
  if (bad) return bad;
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await syncSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: sync failed: ${message(err)}` };
  }
}

/** Fetch the clone's branch into `refs/karst/sandbox/<branch>` and stop; nothing is merged. */
export async function fetchSshDockerClone(ctx: SshDockerCloneContext, input: CloneInput): Promise<StepResult> {
  const bad = nameProblem(ctx);
  if (bad) return bad;
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await fetchSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: fetch failed: ${message(err)}` };
  }
}

/** What a sync would bring in, as a diff against the host branch; nothing is merged. */
export async function diffSshDockerClone(ctx: SshDockerCloneContext, input: CloneInput): Promise<DiffResult> {
  const bad = nameProblem(ctx);
  if (bad) return bad;
  try {
    const bundle = await remoteBundle(ctx, input);
    if (!bundle.ok) return bundle;
    return await diffSandboxBundle({ host: ctx.host, input, bundle: async () => bundle.bytes, ...(ctx.debug ? { debug: ctx.debug } : {}) });
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: diff failed: ${message(err)}` };
  }
}

function refreshScript(input: CloneInput, opts: RefreshOptions | undefined): string {
  const script = opts?.stashMessage === undefined ? REFRESH_SCRIPT : STASH_REFRESH_SCRIPT;
  const setArgs = refreshArgs(input.branch, DOCKER_BUNDLE_IN, opts).map(sshQuote).join(' ');
  return [
    '# karst-ssh-docker-refresh',
    'set -e',
    `cd ${sshQuote(CONTAINER_REPO)} || exit 1`,
    `trap 'rm -f ${DOCKER_BUNDLE_IN}' EXIT`,
    `cat > ${sshQuote(DOCKER_BUNDLE_IN)} || exit 1`,
    `set -- ${setArgs}`,
    script,
  ].join('\n');
}

/** Re-read a dirty refusal (`docker run` gives us no stdout on the pipe), with the marker `refreshOutcome` parses. */
function dirtyDiffScript(): string {
  return [
    '# karst-ssh-docker-refresh-diff',
    `cd ${sshQuote(CONTAINER_REPO)} || exit 1`,
    'if [ -n "$(git status --porcelain)" ]; then',
    `echo "${HOST_AHEAD_MARKER} $(git rev-list --count HEAD..FETCH_HEAD 2>/dev/null)"`,
    'git status --short',
    'git diff HEAD | head -c 20000',
    'fi',
  ].join('\n');
}

/**
 * Host → clone (F8): bundle the host branch and stream it into the helper,
 * which fetches it and fast-forwards (`@arch:AC-46`). A dirty clone or a
 * divergence is refused, never forced; the base ref, when asked for, rides in
 * the same bundle and is force-updated before the branch fetch.
 */
export async function refreshSshDockerClone(
  ctx: SshDockerCloneContext,
  input: CloneInput,
  refreshOpts?: RefreshOptions,
): Promise<SyncResult> {
  const bad = nameProblem(ctx);
  if (bad) return bad;
  try {
    const base = refreshOpts?.baseRef;
    if (base !== undefined && !isSafeBaseRef(base)) {
      return withRemote(ctx, `refusing to ship base ref ${JSON.stringify(base)}`);
    }
    if (base !== undefined) {
      const got = await hostGit(ctx.host, input, ['fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
      if (got.code !== 0) return withRemote(ctx, `git fetch origin ${base} failed: ${tail(got.stderr)}`);
    }
    const to: PipeEnd = { command: ctx.sshBin, args: remoteArgv(ctx, refreshScript(input, refreshOpts)) };
    const piped = await ctx.ssh.pipe({ command: 'git', args: hostBundleArgs(input, base) }, to);
    if (piped.fromCode !== 0) return withRemote(ctx, `git bundle create ${input.branch} failed (exit ${String(piped.fromCode)})`);
    if (piped.toCode === 255) return withRemote(ctx, 'transport failed during refresh');
    if (piped.toCode === REFRESH_DIRTY) {
      const diagnostic = await runDocker(ctx, dirtyDiffScript());
      const stdout = diagnostic.code === 0 ? diagnostic.stdout : '';
      const outcome = refreshOutcome(REFRESH_DIRTY, stdout, diagnostic.stderr, input.branch);
      return outcome.ok ? outcome : withRemote(ctx, outcome.reason);
    }
    const outcome = refreshOutcome(piped.toCode, '', '', input.branch);
    return outcome.ok
      ? { ok: true, summary: `refreshed the docker ssh clone of ${input.branch} on ${ctx.remoteName} from the host` }
      : withRemote(ctx, outcome.reason);
  } catch (err) {
    return { ok: false, reason: `ssh ${ctx.remoteName}: refresh failed: ${message(err)}` };
  }
}
