/**
 * Transient CI failures (T1019): a failed job whose log shows a network fault of GitHub or of a registry, not a code fault.
 *
 * The log is untrusted data: it is bounded, read as text, and only matched against the closed list below. It is never
 * evaluated. Any failure that matches no pattern is NOT transient.
 */

/** The last characters of a job log that are read. A runner fault is at the end of the failed step. */
export const MAX_CI_LOG_CHARS = 200_000;

/**
 * A line is "step-level" when, after the runner timestamp, it starts with a runner annotation, a package-tool prefix or an apt error prefix ("E: ").
 * Test output is printed without such a prefix, so "Request timed out" in an assertion message never counts.
 */
const STEP_LINE = /^(?:\S+Z\s+)?(?:##\[(?:error|warning)\]|npm (?:ERR!|error|warn)\s|prebuild-install (?:warn|ERR!)|gyp (?:ERR!|WARN)|curl: |E: )/;

export interface TransientPattern {
  /** Stable id, named in the bulletin note. */
  readonly id: string;
  /** Matched against one step-level line (see STEP_LINE). */
  readonly re: RegExp;
}

/** The closed list of network patterns. Add a pattern only with a positive and a negative test. */
export const TRANSIENT_CI_PATTERNS: readonly TransientPattern[] = [
  { id: 'http-5xx-response', re: /Unexpected HTTP response: 5\d\d\b/ },
  { id: 'http-5xx-status', re: /HTTP status code: 5\d\d\b/ },
  { id: 'request-timed-out', re: /Request timed out/ },
  { id: 'etimedout', re: /\bETIMEDOUT\b/ },
  { id: 'econnreset', re: /\bECONNRESET\b/ },
  { id: 'eai_again', re: /\bEAI_AGAIN\b/ },
  { id: 'socket-hang-up', re: /socket hang up/ },
  { id: 'codeql-download', re: /Failed to download and extract CodeQL/ },
  { id: 'dns-temporary-failure', re: /Temporary failure resolving/ },
  { id: 'dns-could-not-resolve-host', re: /Could not resolve host/ },
  { id: 'runner-shutdown', re: /The runner has received a shutdown signal/ },
];

/** The id of the first pattern that matches a step-level line of the log tail, or null when the failure is not transient. */
export function classifyTransientLog(log: string): string | null {
  const tail = log.length > MAX_CI_LOG_CHARS ? log.slice(-MAX_CI_LOG_CHARS) : log;
  for (const line of tail.split('\n')) {
    if (!STEP_LINE.test(line)) continue;
    const hit = TRANSIENT_CI_PATTERNS.find((p) => p.re.test(line));
    if (hit) return hit.id;
  }
  return null;
}

export interface CheckUrl { readonly owner: string; readonly repo: string; readonly runId: string; readonly jobId: string }

const JOB_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/;

/** Owner, repo, run id and job id of a GitHub Actions job url. Null for any other url (a status context, a foreign host). */
export function parseCheckUrl(url: string | null): CheckUrl | null {
  const m = url === null ? null : JOB_URL.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, runId: m[3]!, jobId: m[4]! } : null;
}
