import { BEHIND_SUMMARY, classifyCloneRelation, fetchSandboxBundleArgs, resolveSandboxHead } from '../cloneSyncClass.js';
import { detail } from '../docker/dockerPreflight.js';
import type { CloneInput, StepResult } from '../docker/dockerClone.js';
import type { ProcessResult, SbxProcess } from '../sbx/sbxProcess.js';
import type { DiffResult, SyncResult } from '../sessionRunner.js';
import { withXfer } from '../xfer.js';

/**
 * The HOST side of an SSH clone sync (D554, Part C.2), shared by the direct
 * runner and the docker-mode runner (Part D). Only the way the bundle bytes
 * are produced differs: the remote direct clone prints them on stdout, the
 * docker helper prints them from `docker run -i`. Everything after that is the
 * same hardening, so it lives here once.
 *
 * A bundle is written through `agent/xfer.ts` (0700 dir, `O_NOFOLLOW|O_EXCL`
 * temp, then rename) and fetched by its EXPLICIT path into the private
 * `refs/karst/sandbox/<branch>` ref. Host git never reads `FETCH_HEAD` (one
 * file per worktree that every fetch truncates) and never runs anything the
 * clone can influence: hooks are off, fsmonitor is off, git config files
 * outside the command are ignored, and only the `file` transport is allowed
 * for the bundle path. The temp file is removed in `finally`.
 */

/** Host git must ignore the user's and the system's config: a repo-local `fetch.fsck`/hook never runs for a bundle. */
export const HOST_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/**
 * `protocol.allow=never` is the default-deny of every protocol; the bundle is
 * fetched by an explicit path, which is the `file` transport, so that one is
 * allowed back for this command only.
 */
export const HARDENED_FETCH_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
];

/** The one name written into the xfer dir; the path is always host-built. */
export const SANDBOX_BUNDLE_FILE = 'out.bundle';

export interface SshHostJob {
  readonly host: SbxProcess;
  readonly input: CloneInput;
  readonly debug?: (message: string) => void;
}

export interface SshBundleJob extends SshHostJob {
  /** Part C and Part D differ only here: the bytes of the thin bundle to fetch. */
  readonly bundle: () => Promise<Uint8Array>;
}

/** Every host git call carries `-C <hostWorktreePath>`; `env` is only for the hardened fetch. */
export function hostGit(
  host: SbxProcess,
  input: Pick<CloneInput, 'hostWorktreePath'>,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  return host.run('git', ['-C', input.hostWorktreePath, ...args], env ? { env } : undefined);
}

/**
 * Write the bundle bytes through the hardened xfer dir, then fetch them into
 * `refs/karst/sandbox/<branch>` without touching `FETCH_HEAD`. The xfer dir
 * (and so the temp file) is removed in `finally`, also when the fetch throws.
 */
export async function fetchSandboxBundle(job: SshBundleJob): Promise<StepResult> {
  const bytes = await job.bundle();
  job.debug?.(`ssh clone: fetched a ${String(bytes.length)}-byte bundle`);
  return withXfer(async (xfer) => {
    const path = await xfer.write(SANDBOX_BUNDLE_FILE, bytes);
    const fetched = await hostGit(
      job.host,
      job.input,
      [...HARDENED_FETCH_FLAGS, ...fetchSandboxBundleArgs(path, job.input.branch)],
      HOST_GIT_ENV,
    );
    if (fetched.code !== 0) return { ok: false, reason: `git fetch of the sandbox bundle failed: ${detail(fetched)}` };
    return { ok: true };
  });
}

/**
 * Resolve the private ref ONCE and fast-forward to that sha. A divergence is
 * refused, never forced; a clone that is merely behind is a no-op (the
 * host → clone refresh catches it up).
 */
export async function mergeSandboxHead(job: SshHostJob): Promise<SyncResult> {
  const git = (args: string[]): Promise<ProcessResult> => hostGit(job.host, job.input, args);
  const head = await resolveSandboxHead(git, job.input.branch);
  if (!head.ok) return head;
  const relation = await classifyCloneRelation(head.sha, async (older, newer) => (await git(['merge-base', '--is-ancestor', older, newer])).code === 0);
  if (relation === 'behind') return { ok: true, summary: BEHIND_SUMMARY };
  if (relation === 'diverged') {
    return { ok: false, reason: `refused: the sandbox's ${job.input.branch} is not a fast-forward of the host branch (never forced)` };
  }
  const merged = await git(['merge', '--ff-only', head.sha]);
  if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only failed: ${detail(merged)}` };
  return { ok: true, summary: `fast-forwarded ${job.input.branch} to the ssh sandbox's commits` };
}

/** Fetch the clone's branch into the private ref and fast-forward; nothing else is merged. */
export async function syncSandboxBundle(job: SshBundleJob): Promise<SyncResult> {
  const fetched = await fetchSandboxBundle(job);
  if (!fetched.ok) return fetched;
  return mergeSandboxHead(job);
}

/** What a sync would bring in, as a diff against the host branch; nothing is merged. */
export async function diffSandboxBundle(job: SshBundleJob): Promise<DiffResult> {
  const fetched = await fetchSandboxBundle(job);
  if (!fetched.ok) return fetched;
  const git = (args: string[]): Promise<ProcessResult> => hostGit(job.host, job.input, args);
  const head = await resolveSandboxHead(git, job.input.branch);
  if (!head.ok) return head;
  const diff = await git(['diff', `HEAD...${head.sha}`]);
  if (diff.code !== 0) return { ok: false, reason: `git diff failed: ${detail(diff)}` };
  return { ok: true, diff: diff.stdout, ref: head.sha };
}
