import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncResult } from '../sessionRunner.js';
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
}

/** Clone the ticket branch into the repo volume unless a clone is already there. */
export async function ensureClone(ctx: CloneContext, input: CloneInput): Promise<StepResult> {
  const probe = helper(ctx, volumeMounts(ctx.names), ['git', '-C', CONTAINER_REPO, 'rev-parse', '--git-dir']);
  if ((await ctx.proc.run(DOCKER_BIN, probe)).code === 0) return { ok: true };
  const git = (args: string[]) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...args]);
  const name = (await git(['config', 'user.name'])).stdout.trim();
  const email = (await git(['config', 'user.email'])).stdout.trim();
  return withTemp(ctx.temp, async (dir) => {
    const bundled = await git(['bundle', 'create', join(dir, 'in.bundle'), input.branch]);
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

async function syncThroughBundle(ctx: CloneContext, input: CloneInput): Promise<SyncResult> {
  const git = (args: string[]) => ctx.proc.run('git', ['-C', input.hostWorktreePath, ...args]);
  return withTemp(ctx.temp, async (dir) => {
    const bundled = await ctx.proc.run(DOCKER_BIN, helper(
      ctx,
      [...volumeMounts(ctx.names, { repoReadonly: true }), '--mount', bindMount(dir, BUNDLE_DIR, false)],
      ['git', '-c', 'safe.directory=*', '-C', CONTAINER_REPO, 'bundle', 'create', `${BUNDLE_DIR}/out.bundle`, input.branch],
    ));
    if (bundled.code !== 0) return { ok: false, reason: `no sandbox clone to sync from: ${detail(bundled)}` };
    const fetched = await git(['fetch', join(dir, 'out.bundle'), `refs/heads/${input.branch}`]);
    if (fetched.code !== 0) return { ok: false, reason: `git fetch of the sandbox bundle failed: ${detail(fetched)}` };
    if ((await git(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'])).code !== 0) {
      return { ok: false, reason: `refused: the sandbox's ${input.branch} is not a fast-forward of the host branch (never forced)` };
    }
    const merged = await git(['merge', '--ff-only', 'FETCH_HEAD']);
    if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only failed: ${detail(merged)}` };
    return { ok: true, summary: `fast-forwarded ${input.branch} to the docker sandbox's commits` };
  });
}
