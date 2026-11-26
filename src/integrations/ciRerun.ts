import type { GhRunner } from './github.js';
import { MAX_CI_LOG_CHARS, parseCheckUrl, type CheckUrl } from '../workflow/transientCi.js';
import { extractFailingTestIds } from '../workflow/baseRedCi.js';

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

/** The newest develop runs read per check (T1383, @arch:AP-12). */
export const BASE_RUN_LIMIT = 20;
/** The develop job ids kept in memory: a completed run never changes, so a red develop is not read again on every probe. */
const MAX_MEMO = 200;
const BASE_RE = /^[A-Za-z0-9._/-]+$/;
const RUN_ID_RE = /^\d+$/;

/** One completed push run of a workflow on the base branch. */
export interface BaseRun { readonly runId: string; readonly headSha: string; readonly conclusion: string }

/** The workflow id of a run (digits). */
export async function readRunWorkflowId(gh: GhRunner, cwd: string, c: CheckUrl): Promise<string> {
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/actions/runs/${c.runId}`, '--jq', '.workflow_id'], cwd);
  if (r.exitCode !== 0) fail('reading the run workflow', r.stderr, r.exitCode);
  const id = r.stdout.trim();
  if (!RUN_ID_RE.test(id)) throw new Error('reading the run workflow failed (gh named no workflow)');
  return id;
}

function isBaseRunRow(x: unknown): x is { databaseId: number; headSha: string; conclusion: string } {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return Number.isSafeInteger(o.databaseId) && typeof o.headSha === 'string' && SHA_RE.test(o.headSha) && typeof o.conclusion === 'string';
}

function parseJson(stdout: string, what: string): unknown {
  try { return JSON.parse(stdout); } catch { throw new Error(`${what} failed (gh gave an unknown shape)`); }
}

/** The newest completed push runs of the workflow on `base`, newest first (gh's order). */
export async function listBaseRuns(gh: GhRunner, cwd: string, c: CheckUrl, workflowId: string, base: string): Promise<BaseRun[]> {
  if (!BASE_RE.test(base) || base.startsWith('-') || base.includes('..')) throw new Error('listing the base runs failed (unsafe base branch name)');
  if (!RUN_ID_RE.test(workflowId)) throw new Error('listing the base runs failed (unsafe workflow id)');
  const r = await gh([
    'run', 'list', '--repo', `${c.owner}/${c.repo}`, '--branch', base, '--event', 'push', '--workflow', workflowId, '--status', 'completed',
    '--limit', String(BASE_RUN_LIMIT), '--json', 'databaseId,headSha,conclusion',
  ], cwd);
  if (r.exitCode !== 0) fail('listing the base runs', r.stderr, r.exitCode);
  const rows = parseJson(r.stdout, 'listing the base runs');
  if (!Array.isArray(rows) || !rows.every(isBaseRunRow)) throw new Error('listing the base runs failed (gh gave an unknown shape)');
  return rows.map((x) => ({ runId: String(x.databaseId), headSha: x.headSha, conclusion: x.conclusion }));
}

/** The job of a run that has this name, as a check url, or null when the run has no such job. */
export async function readRunJobByName(gh: GhRunner, cwd: string, c: CheckUrl, runId: string, jobName: string): Promise<CheckUrl | null> {
  if (!RUN_ID_RE.test(runId)) throw new Error('reading the base run jobs failed (unsafe run id)');
  const r = await gh(['run', 'view', runId, '--repo', `${c.owner}/${c.repo}`, '--json', 'jobs'], cwd);
  if (r.exitCode !== 0) fail('reading the base run jobs', r.stderr, r.exitCode);
  const body = parseJson(r.stdout, 'reading the base run jobs') as { jobs?: unknown };
  if (typeof body !== 'object' || body === null || !Array.isArray(body.jobs)) throw new Error('reading the base run jobs failed (gh gave an unknown shape)');
  const job = (body.jobs as Array<{ name?: unknown; url?: unknown }>).find((j) => j?.name === jobName);
  return job !== undefined && typeof job.url === 'string' ? parseCheckUrl(job.url) : null;
}

/** True when `commit` is in the history of `head` (GitHub compare status `ahead` or `identical`). */
export async function commitInHead(gh: GhRunner, cwd: string, c: CheckUrl, commit: string, head: string): Promise<boolean> {
  if (!SHA_RE.test(commit) || !SHA_RE.test(head)) throw new Error('comparing the base commit failed (unsafe sha)');
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/compare/${commit}...${head}`, '--jq', '.status'], cwd);
  if (r.exitCode !== 0) fail('comparing the base commit', r.stderr, r.exitCode);
  const status = r.stdout.trim();
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  throw new Error('comparing the base commit failed (gh named no status)');
}

/** The seams of the base-red step (T1383, @arch:AP-12). Each throws on a gh failure; the step then gives today's rules. */
export interface BaseRedSeams {
  readonly readJobLog: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly readRunHeadSha: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly readRunWorkflowId: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly listBaseRuns: (cwd: string, c: CheckUrl, workflowId: string, base: string) => Promise<readonly BaseRun[]>;
  /** The failing ids of the job named `jobName` in a develop run; null when the run has no such job. */
  readonly baseRunIds: (cwd: string, c: CheckUrl, runId: string, jobName: string) => Promise<readonly string[] | null>;
  readonly commitInHead: (cwd: string, c: CheckUrl, commit: string, head: string) => Promise<boolean>;
  /** Rebase on base for one repo, with no confirm prompt. True only when it pushed. */
  readonly rebase: (repo: string) => Promise<boolean>;
}

export function makeBaseRedSeams(gh: GhRunner, rebase: (repo: string) => Promise<boolean>): BaseRedSeams {
  const memo = new Map<string, readonly string[] | null>();
  const baseRunIds = async (cwd: string, c: CheckUrl, runId: string, jobName: string): Promise<readonly string[] | null> => {
    const key = `${c.owner}/${c.repo}\0${runId}\0${jobName}`;
    if (memo.has(key)) return memo.get(key)!;
    const job = await readRunJobByName(gh, cwd, c, runId, jobName);
    const ids = job === null ? null : extractFailingTestIds(await readJobLog(gh, cwd, job));
    if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value!);
    memo.set(key, ids);
    return ids;
  };
  return {
    readJobLog: (cwd, c) => readJobLog(gh, cwd, c),
    readRunHeadSha: (cwd, c) => readRunHeadSha(gh, cwd, c),
    readRunWorkflowId: (cwd, c) => readRunWorkflowId(gh, cwd, c),
    listBaseRuns: (cwd, c, workflowId, base) => listBaseRuns(gh, cwd, c, workflowId, base),
    baseRunIds,
    commitInHead: (cwd, c, commit, head) => commitInHead(gh, cwd, c, commit, head),
    rebase,
  };
}
