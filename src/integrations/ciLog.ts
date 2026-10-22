import type { FailingCheck } from '../model/prChecks.js';
import type { GhRunner } from './github.js';

/**
 * Failing CI logs, fetched on the host (the sandbox has no GitHub egress) and
 * reduced to a bounded excerpt. Everything gh returns here is untrusted text:
 * it is capped, ANSI-stripped, and rendered to the agent as data.
 */

export const MAX_EXCERPT_LINES = 200;
export const MAX_EXCERPT_BYTES = 16 * 1024;
// Cap of the raw `--log-failed` fetch; the tail is kept because the failure is at the end.
export const MAX_LOG_FETCH_BYTES = 1024 * 1024;

const ACTIONS_URL = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// gh --log-failed: `<job>\t<step>\t<iso timestamp> <line>`
const GH_PREFIX = /^[^\t\n]*\t[^\t\n]*\t\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const INTERESTING = /error|fail|assert|##\[error\]/i;

export interface ActionsRef {
  runId: string;
  jobId: string | null;
}

/** The run/job ids of a GitHub Actions check url, or null (null, external, malformed). */
export function parseActionsUrl(url: string | null): ActionsRef | null {
  if (url === null) return null;
  const m = ACTIONS_URL.exec(url);
  return m ? { runId: m[1]!, jobId: m[2] ?? null } : null;
}

/** Error/fail/assert lines plus a capped tail, ANSI and gh prefixes stripped, bounded in lines and bytes. */
export function buildExcerpt(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.replace(ANSI, '').replace(GH_PREFIX, ''));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const tailStart = Math.max(0, lines.length - Math.floor(MAX_EXCERPT_LINES / 2));
  const head = lines
    .slice(0, tailStart)
    .filter((l) => INTERESTING.test(l))
    .slice(0, MAX_EXCERPT_LINES - (lines.length - tailStart));
  let out = [...head, ...lines.slice(tailStart)].join('\n');
  while (Buffer.byteLength(out) > MAX_EXCERPT_BYTES) {
    out = out.slice(Math.max(1, out.length - Math.floor(MAX_EXCERPT_BYTES / 2)));
    out = out.slice(out.indexOf('\n') + 1);
  }
  return out;
}

export type CheckLog =
  | { kind: 'external'; note: string }
  | { kind: 'pending'; name: string; steps: string[] }
  | { kind: 'log'; name: string; text: string };

function ghError(action: string, r: { stderr?: string; stdout: string }): Error {
  const detail = (r.stderr ?? r.stdout).trim().slice(0, 300);
  return new Error(`gh could not ${action}: ${detail || 'no output'}`);
}

function failedSteps(jobs: unknown): string[] {
  if (!Array.isArray(jobs)) return [];
  const out: string[] = [];
  for (const j of jobs as Array<Record<string, unknown>>) {
    const steps = Array.isArray(j.steps) ? (j.steps as Array<Record<string, unknown>>) : [];
    for (const s of steps) {
      if (s.conclusion === 'failure') out.push(`${String(j.name ?? 'job')}: ${String(s.name ?? 'step')}`);
    }
  }
  return out;
}

/**
 * One failing check's log. Throws on a gh failure (auth, expired run, rate limit)
 * so the caller can refuse before moving the ticket.
 */
export async function fetchCheckLog(gh: GhRunner, cwd: string, check: FailingCheck): Promise<CheckLog> {
  const ref = parseActionsUrl(check.url);
  if (ref === null) {
    return { kind: 'external', note: `${check.name}: no Actions log (external check), see ${check.url ?? 'no url'}` };
  }
  const view = await gh(['run', 'view', ref.runId, '--json', 'status,jobs'], cwd);
  if (view.exitCode !== 0) throw ghError(`read CI run ${ref.runId}`, view);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(view.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`gh returned an unreadable answer for CI run ${ref.runId}`);
  }
  if (parsed.status !== 'completed') {
    return { kind: 'pending', name: check.name, steps: failedSteps(parsed.jobs) };
  }
  const args = ['run', 'view', ref.runId, '--log-failed', ...(ref.jobId ? ['--job', ref.jobId] : [])];
  const log = await gh(args, cwd, { truncation: 'keep-tail', maxOutputBytes: MAX_LOG_FETCH_BYTES });
  if (log.exitCode !== 0) throw ghError(`fetch the CI log of run ${ref.runId}`, log);
  return {
    kind: 'log',
    name: check.name,
    text: log.truncated
      ? `[log truncated: kept last ${MAX_LOG_FETCH_BYTES / 1024} KiB of a larger log]\n${buildExcerpt(log.stdout)}`
      : buildExcerpt(log.stdout),
  };
}
