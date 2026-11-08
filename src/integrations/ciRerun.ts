import type { GhRunner } from './github.js';
import { MAX_CI_LOG_CHARS, type CheckUrl } from '../workflow/transientCi.js';

/**
 * The three gh calls of the transient CI re-run (T1019). Each throws an Error with a short reason when gh fails:
 * the caller parks on a throw and never reads an unknown result as a pass.
 * The ids come from `parseCheckUrl` (digits and name-safe characters only), so they are safe as gh arguments.
 */

const SHA_RE = /^[0-9a-f]{40}$/;

function fail(what: string, stderr: string | undefined, exitCode: number): never {
  const detail = (stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  throw new Error(`${what} failed (gh exit ${exitCode}${detail === '' ? '' : `: ${detail}`})`);
}

/** The tail of a job log as text. Bounded twice: gh keeps the last bytes, and the classifier reads the last characters. */
export async function readJobLog(gh: GhRunner, cwd: string, c: CheckUrl): Promise<string> {
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/actions/jobs/${c.jobId}/logs`], cwd, {
    truncation: 'keep-tail', maxOutputBytes: MAX_CI_LOG_CHARS * 2,
  });
  if (r.exitCode !== 0) fail('reading the job log', r.stderr, r.exitCode);
  return r.stdout;
}

/** The head sha of a workflow run (40 hex characters). */
export async function readRunHeadSha(gh: GhRunner, cwd: string, c: CheckUrl): Promise<string> {
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/actions/runs/${c.runId}`, '--jq', '.head_sha'], cwd);
  if (r.exitCode !== 0) fail('reading the run head', r.stderr, r.exitCode);
  const sha = r.stdout.trim();
  if (!SHA_RE.test(sha)) throw new Error('reading the run head failed (gh named no head sha)');
  return sha;
}

/** Re-run the failed jobs of a run (`gh run rerun <id> --failed`). */
export async function rerunFailedJobs(gh: GhRunner, cwd: string, c: CheckUrl): Promise<void> {
  const r = await gh(['run', 'rerun', c.runId, '--failed', '--repo', `${c.owner}/${c.repo}`], cwd);
  if (r.exitCode !== 0) fail('the re-run', r.stderr, r.exitCode);
}

/** The three calls bound to one gh runner, as the autopilot engine takes them. */
export function makeTransientCiSeams(gh: GhRunner): {
  readJobLog: (cwd: string, c: CheckUrl) => Promise<string>;
  readRunHeadSha: (cwd: string, c: CheckUrl) => Promise<string>;
  rerunFailedJobs: (cwd: string, c: CheckUrl) => Promise<void>;
} {
  return {
    readJobLog: (cwd, c) => readJobLog(gh, cwd, c),
    readRunHeadSha: (cwd, c) => readRunHeadSha(gh, cwd, c),
    rerunFailedJobs: (cwd, c) => rerunFailedJobs(gh, cwd, c),
  };
}
