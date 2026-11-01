import type { StepOutcome } from '../sessionRunner.js';
import { sandboxHeadRef } from '../cloneSyncClass.js';
import { SBX_BIN } from './sbxPreflight.js';
import type { SbxProcess } from './sbxProcess.js';

/** The block reason when the sandbox clone never got a ticket branch (HEAD stays `refs/heads/.invalid`). */
export const SANDBOX_CLONE_EMPTY_REASON = 'sandbox clone is empty: run Karst: Rebuild Sandbox to recreate it from the host branch';

/** A fresh clone shows an `.invalid` HEAD briefly (T897), so readiness is polled, not judged once. */
export const CLONE_READY_TIMEOUT_MS = 30_000;
export const CLONE_READY_INTERVAL_MS = 1_000;

/** Exit code the readiness script uses for "the ticket branch does not resolve", so other `sbx exec` failures are not misread as empty. */
const CLONE_EMPTY_EXIT = 74;

/** Runs in the sandbox: does `refs/heads/$1` resolve to a commit? */
const READY_SCRIPT = [
  'sh', '-c',
  `git -c 'safe.directory=*' rev-parse --verify -q "refs/heads/$1^{commit}" >/dev/null || exit ${CLONE_EMPTY_EXIT}`,
  'karst-clone-ready',
] as const;

/** Runs in the sandbox: every object name any ref points at. */
const LIST_REFS = ['sh', '-c', `git -c 'safe.directory=*' for-each-ref --format='%(objectname)'`] as const;

const SHA = /^[0-9a-f]{40,64}$/;

export interface CloneReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the sandbox clone's ticket branch resolves. Only the empty-clone exit blocks; any other
 * `sbx exec` failure (sandbox absent, CLI down) is left to the step that follows, which already reports it.
 */
export async function waitForCloneReady(
  proc: SbxProcess,
  input: { readonly name: string; readonly branch: string; readonly cloneDir?: string },
  opts: CloneReadyOptions = {},
): Promise<StepOutcome> {
  const interval = opts.intervalMs ?? CLONE_READY_INTERVAL_MS;
  const attempts = Math.floor((opts.timeoutMs ?? CLONE_READY_TIMEOUT_MS) / interval) + 1;
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < attempts; i++) {
    const out = await proc.run(SBX_BIN, ['exec', input.name, '--', ...READY_SCRIPT, input.branch], input.cloneDir ? { cwd: input.cloneDir } : undefined);
    if (out.code !== CLONE_EMPTY_EXIT) return { ok: true };
    if (i < attempts - 1) await sleep(interval);
  }
  return { ok: false, reason: SANDBOX_CLONE_EMPTY_REASON };
}

/**
 * May the sandbox be removed and rebuilt from the host branch without losing work? Only when every commit
 * any sandbox ref points at is already on the host branch or on the sandbox sync ref. Anything unreadable refuses.
 */
export async function assertRebuildSafe(
  proc: SbxProcess,
  input: { readonly name: string; readonly branch: string; readonly cloneDir?: string },
  hostGit: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<StepOutcome> {
  const listed = await proc.run(SBX_BIN, ['exec', input.name, '--', ...LIST_REFS], input.cloneDir ? { cwd: input.cloneDir } : undefined);
  if (listed.code !== 0) return { ok: false, reason: `cannot verify the sandbox commits, so it was not rebuilt: ${listed.stderr.trim()}` };
  const shas = [...new Set(listed.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''))];
  const syncRef = sandboxHeadRef(input.branch);
  const syncRefPresent = (await hostGit(['rev-parse', '--verify', '--quiet', `${syncRef}^{commit}`])).code === 0;
  for (const sha of shas) {
    if (!SHA.test(sha)) return { ok: false, reason: `cannot verify the sandbox commits, so it was not rebuilt: unexpected ref output` };
    const onHost = (await hostGit(['merge-base', '--is-ancestor', sha, input.branch])).code === 0;
    const onSyncRef = !onHost && syncRefPresent && (await hostGit(['merge-base', '--is-ancestor', sha, syncRef])).code === 0;
    if (!onHost && !onSyncRef) return { ok: false, reason: `sandbox holds commits (${sha.slice(0, 12)}) that are not on ${input.branch} or its sync ref, so it was not rebuilt: sync it first` };
  }
  return { ok: true };
}
