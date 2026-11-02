import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_REF_PREFIX, REFRESH_SCRIPT, STASH_REFRESH_SCRIPT, hostBaseRef, isSafeBaseRef, refreshArgs, refreshOutcome } from '../cloneRefresh.js';
import { BEHIND_SUMMARY, classifyCloneRelation, fetchSandboxBundleArgs, resolveSandboxHead } from '../cloneSyncClass.js';
import type { DiffResult, RefreshOptions, SyncResult } from '../sessionRunner.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerNames } from './dockerNames.js';
import { detail, DOCKER_BIN } from './dockerPreflight.js';
import type { DockerProcess } from './dockerProcess.js';
import { bindMount, CONTAINER_DATA, CONTAINER_REPO, CONTAINER_WORK, HARDENING, type LinuxUser, userArgs, volumeMounts } from './dockerRunArgs.js';

/**
 * Clone mode over `git bundle` files (arch:AC-33, plan task 6). Neither the
 * host worktree nor its shared `.git` is ever mounted into the container: a
 * bundle of the ticket branch goes in once, a bundle of the clone's branch
 * comes out on sync, and the host fast-forwards from it. The host only ever
 * runs `git fetch` of a bundle and `merge --ff-only`, so nothing the agent
 * writes (hooks, config) can execute on the host — ST2B blocker 1 is gone,
 * not mitigated. Chosen over a `git daemon` on the internal network: no
 * long-lived listener, no port, and the helper containers run `--network none`.
 */

export interface TempDirs {
  make(): Promise<string>;
  remove(path: string): Promise<void>;
}

export const OS_TEMP_DIRS: TempDirs = {
  make: () => mkdtemp(join(tmpdir(), 'karst-docker-')),
  remove: (path) => rm(path, { recursive: true, force: true }),
};

export interface CloneContext {
  readonly proc: DockerProcess;
  readonly names: DockerNames;
  readonly user: LinuxUser | undefined;
  readonly temp: TempDirs;
}

export type StepResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const BUNDLE_DIR = '/bundle';

function helper(ctx: CloneContext, extra: readonly string[], command: readonly string[]): string[] {
  return ['run', '--rm', '--network', 'none', ...HARDENING, ...userArgs(ctx.user), ...extra, OPENCODE_IMAGE, ...command];
}

async function withTemp<T>(temp: TempDirs, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await temp.make();
  try {
    return await body(dir);
  } finally {
    await temp.remove(dir);
  }
}

/** Create a missing volume; true when it was created now. */
export async function ensureVolume(proc: DockerProcess, volume: string): Promise<StepResult & { created?: boolean }> {
  if ((await proc.run(DOCKER_BIN, ['volume', 'inspect', volume])).code === 0) return { ok: true, created: false };
  const made = await proc.run(DOCKER_BIN, ['volume', 'create', volume]);
  if (made.code !== 0) return { ok: false, reason: `docker volume create ${volume} failed: ${detail(made)}` };
  return { ok: true, created: true };
}

/**
 * Linux: a fresh named volume copies the image's `node` (1000) ownership, so a
 * different host uid could not write it. Hand both volumes to that uid once,
 * as root INSIDE a throwaway container — no host path is touched.
 */
export async function chownVolumes(ctx: CloneContext): Promise<StepResult> {
  if (!ctx.user) return { ok: true };
  const owner = `${ctx.user.uid}:${ctx.user.gid}`;
  const run = await ctx.proc.run(DOCKER_BIN, [
    'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
    '--user', '0', ...volumeMounts(ctx.names),
    OPENCODE_IMAGE, 'chown', owner, CONTAINER_WORK, CONTAINER_DATA,
  ]);
  return run.code === 0 ? { ok: true } : { ok: false, reason: `docker volume chown failed: ${detail(run)}` };
}

export interface CloneInput {
  readonly hostWorktreePath: string;
  readonly branch: string;
  /** Base branch; when set, its host ref rides in the first bundle so the clone can resolve a merge base before any sync. */
  readonly baseRef?: string;
}

/** Clone the ticket branch into the repo volume unless a clone is already there. */
export async function ensureClone(ctx: CloneContext, input: CloneInput): Promise<StepResult> {
  const probe = helper(ctx, volumeMounts(ctx.names), ['git', '-C', CONTAINER_REPO, 'rev-parse', '--git-dir']);
  if ((await ctx.proc.run(DOCKER_BIN, probe)).code === 0) return { ok: true };
  const git = (args: string[]) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...args]);
  const name = (await git(['config', 'user.name'])).stdout.trim();
  const email = (await git(['config', 'user.email'])).stdout.trim();
  return withTemp(ctx.temp, async (dir) => {
    let base = input.baseRef && isSafeBaseRef(input.baseRef) ? input.baseRef : undefined;
    if (base) {
      // Best effort: an offline host keeps whatever origin/<base> it already has; no ref at all means no base in the bundle.
      await git(['fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
      if ((await git(['rev-parse', '--verify', '-q', hostBaseRef(base)])).code !== 0) base = undefined;
    }
    const bundled = await git(['bundle', 'create', join(dir, 'in.bundle'), input.branch, ...(base ? [hostBaseRef(base)] : [])]);
    if (bundled.code !== 0) return { ok: false, reason: `git bundle create ${input.branch} failed: ${detail(bundled)}` };
    const identity = [
      ...(name ? ['--config', `user.name=${name}`] : []),
      ...(email ? ['--config', `user.email=${email}`] : []),
    ];
    const cloned = await ctx.proc.run(DOCKER_BIN, helper(
      ctx,
      [...volumeMounts(ctx.names), '--mount', bindMount(dir, BUNDLE_DIR, true)],
      ['git', 'clone', ...identity, '--branch', input.branch, `${BUNDLE_DIR}/in.bundle`, CONTAINER_REPO],
    ));
    if (cloned.code === 0 && base) {
      // A clone only fetches branch heads: pin the bundled base under the karst-owned ref the sync path uses.
      const pinned = await ctx.proc.run(DOCKER_BIN, helper(
        ctx,
        [...volumeMounts(ctx.names), '--mount', bindMount(dir, BUNDLE_DIR, true)],
        ['git', '-C', CONTAINER_REPO, 'fetch', '-q', `${BUNDLE_DIR}/in.bundle`, `+${hostBaseRef(base)}:${BASE_REF_PREFIX}${base}`],
      ));
      if (pinned.code !== 0) return { ok: false, reason: `pinning base ${base} in ${ctx.names.repoVolume} failed: ${detail(pinned)}` };
    }
    return cloned.code === 0 ? { ok: true } : { ok: false, reason: `clone into ${ctx.names.repoVolume} failed: ${detail(cloned)}` };
  });
}

/**
 * Bring the clone's commits into the host worktree: bundle the branch out of
 * the (read-only mounted) volume, fetch the bundle, fast-forward or refuse.
 */
export async function syncFromClone(ctx: CloneContext, input: CloneInput): Promise<SyncResult> {
  try {
    return await syncThroughBundle(ctx, input);
  } catch (err) {
    return { ok: false, reason: `docker sync failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Bundle the clone's branch out of the volume and fetch it into the private `refs/karst/sandbox/<branch>` of the host worktree (FETCH_HEAD is never written). */
async function fetchCloneBundle(ctx: CloneContext, input: CloneInput, dir: string): Promise<StepResult> {
  const bundled = await ctx.proc.run(DOCKER_BIN, helper(
    ctx,
    [...volumeMounts(ctx.names, { repoReadonly: true }), '--mount', bindMount(dir, BUNDLE_DIR, false)],
    ['git', '-c', 'safe.directory=*', '-C', CONTAINER_REPO, 'bundle', 'create', `${BUNDLE_DIR}/out.bundle`, input.branch],
  ));
  if (bundled.code !== 0) return { ok: false, reason: `no sandbox clone to sync from: ${detail(bundled)}` };
  const fetched = await ctx.proc.run('git', ['-C', input.hostWorktreePath, ...fetchSandboxBundleArgs(join(dir, 'out.bundle'), input.branch)]);
  if (fetched.code !== 0) return { ok: false, reason: `git fetch of the sandbox bundle failed: ${detail(fetched)}` };
  return { ok: true };
}

async function syncThroughBundle(ctx: CloneContext, input: CloneInput): Promise<SyncResult> {
  const git = (args: string[]) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...args]);
  return withTemp(ctx.temp, async (dir) => {
    const fetched = await fetchCloneBundle(ctx, input, dir);
    if (!fetched.ok) return fetched;
    const head = await resolveSandboxHead(git, input.branch);
    if (!head.ok) return head;
    const relation = await classifyCloneRelation(head.sha, async (older, newer) => (await git(['merge-base', '--is-ancestor', older, newer])).code === 0);
    if (relation === 'behind') return { ok: true, summary: BEHIND_SUMMARY };
    if (relation === 'diverged') {
      return { ok: false, reason: `refused: the sandbox's ${input.branch} is not a fast-forward of the host branch (never forced)` };
    }
    const merged = await git(['merge', '--ff-only', head.sha]);
    if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only failed: ${detail(merged)}` };
    return { ok: true, summary: `fast-forwarded ${input.branch} to the docker sandbox's commits` };
  });
}

/** Fetch the clone's branch into the host worktree's private sandbox ref and stop; nothing is merged. */
export async function fetchFromClone(ctx: CloneContext, input: CloneInput): Promise<StepResult> {
  try {
    return await withTemp(ctx.temp, (dir) => fetchCloneBundle(ctx, input, dir));
  } catch (err) {
    return { ok: false, reason: `docker fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What `syncFromClone` would bring in, as a diff against the host branch; nothing is merged. */
export async function diffFromClone(ctx: CloneContext, input: CloneInput): Promise<DiffResult> {
  try {
    return await withTemp(ctx.temp, async (dir) => {
      const fetched = await fetchCloneBundle(ctx, input, dir);
      if (!fetched.ok) return fetched;
      const head = await resolveSandboxHead((args) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...args]), input.branch);
      if (!head.ok) return head;
      const diff = await ctx.proc.run('git', ['-C', input.hostWorktreePath, 'diff', `HEAD...${head.sha}`]);
      if (diff.code !== 0) return { ok: false as const, reason: `git diff failed: ${detail(diff)}` };
      return { ok: true as const, diff: diff.stdout, ref: head.sha };
    });
  } catch (err) {
    return { ok: false, reason: `docker diff failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Host → sandbox (F8): bundle the host branch, then fetch and fast-forward the
 * clone inside a `--network none` helper that sees the bundle read-only. No
 * host git ever runs in the agent-written clone; dirty or diverged → refused.
 */
export async function refreshClone(ctx: CloneContext, input: CloneInput, refreshOpts?: RefreshOptions): Promise<SyncResult> {
  try {
    return await withTemp(ctx.temp, async (dir): Promise<SyncResult> => {
      const base = refreshOpts?.baseRef;
      if (base && !isSafeBaseRef(base)) return { ok: false, reason: `refusing to ship base ref ${JSON.stringify(base)}` };
      if (base) {
        const got = await ctx.proc.run('git', ['-C', input.hostWorktreePath, 'fetch', 'origin', `+refs/heads/${base}:${hostBaseRef(base)}`]);
        if (got.code !== 0) return { ok: false, reason: `git fetch origin ${base} failed: ${detail(got)}` };
      }
      const bundled = await ctx.proc.run('git', ['-C', input.hostWorktreePath, 'bundle', 'create', join(dir, 'in.bundle'), input.branch, ...(base ? [hostBaseRef(base)] : [])]);
      if (bundled.code !== 0) return { ok: false, reason: `git bundle create ${input.branch} failed: ${detail(bundled)}` };
      const run = await ctx.proc.run(DOCKER_BIN, helper(
        ctx,
        [...volumeMounts(ctx.names), '--mount', bindMount(dir, BUNDLE_DIR, true)],
        ['sh', '-c', `cd ${CONTAINER_REPO}\n${refreshOpts?.stashMessage ? STASH_REFRESH_SCRIPT : REFRESH_SCRIPT}`, 'karst-refresh', ...refreshArgs(input.branch, `${BUNDLE_DIR}/in.bundle`, refreshOpts)],
      ));
      return refreshOutcome(run.code, run.stdout, run.stderr, input.branch);
    });
  } catch (err) {
    return { ok: false, reason: `docker refresh failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
