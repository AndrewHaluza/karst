import { spawn } from 'node:child_process';
import { GH_DEPENDENCY, renderMissingDependency } from '../runtime/deps.js';
import { BoundedOutput } from '../runtime/boundedOutput.js';
import { killTree } from '../runtime/processTree.js';

/**
 * GitHub integration (§12, §15) — shells out to `gh`. The runner is injected so
 * ship logic is unit-testable without a real repo or network; the default runner
 * calls the `gh` CLI, inheriting the user's auth.
 */

export interface GhResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

export interface OpenPrOpts {
  cwd: string;
  title: string;
  body: string;
  base?: string; // target branch; gh defaults to the repo default
}

export interface OpenedPr {
  number: number | null;
  url: string;
}

/** Process outcome narrowed to the fields the mapping below reads. */
interface SpawnOutcome {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error & { code?: string };
}

/**
 * Map a process outcome onto a `GhResult`, never losing the reason.
 *
 * When the spawn itself fails (gh not installed → ENOENT), `status` is null:
 * gh never ran, so the ONLY account of what happened is
 * `error`. Dropping it produced the empty "gh pr create failed in <cwd>: " that
 * told the user nothing. A failure always carries some text out of here.
 *
 * ENOENT gets translated rather than quoted: this text is what the dashboard's
 * fault card puts in front of the user, and "spawnSync gh ENOENT" is a true
 * sentence they cannot act on. The wording comes from the dependency registry —
 * the same sentence the preflight and the checklist show — so install copy lives
 * in exactly one place. Every other spawn error is passed through as-is.
 */
export function toGhResult(r: SpawnOutcome): GhResult {
  const exitCode = r.status ?? 1;
  const spawnFailure = r.error
    ? r.error.code === 'ENOENT'
      ? renderMissingDependency(GH_DEPENDENCY)
      : `could not run gh: ${r.error.message}`
    : '';
  const stderr =
    r.stderr || spawnFailure || (exitCode !== 0 ? `gh exited ${exitCode} without a message` : '');
  return { stdout: r.stdout ?? '', stderr, exitCode };
}

export const GH_TIMEOUT_MS = 2 * 60_000;
export const GH_MAX_OUTPUT_BYTES = 1024 * 1024;
export const GH_TERMINATION_GRACE_MS = 5_000;

export interface GhRunnerOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
}

/**
 * Non-blocking default `gh` runner.
 *
 * Required for anything that runs on the extension host's event loop on a timer
 * (the PR status sync), not just in a one-off user action. `spawnSync` there
 * would freeze the host — hook endpoint, every webview, the whole UI — for the
 * length of a network `gh pr view`, once a minute (same trap the gate runner
 * avoids). The output→`GhResult` mapping (incl. the ENOENT→install-copy
 * translation) remains centralized in `toGhResult`.
 */
export const defaultGhRunnerAsync = (
  args: string[],
  cwd: string,
  options: GhRunnerOptions = {},
): Promise<GhResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? GH_MAX_OUTPUT_BYTES;
    const terminationGraceMs = options.terminationGraceMs ?? GH_TERMINATION_GRACE_MS;
    const stdout = new BoundedOutput(Math.max(0, maxOutputBytes));
    const stderr = new BoundedOutput(Math.max(0, maxOutputBytes));
    let settled = false;
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: GhResult): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      resolve(result);
    };
    const outcome = (status: number | null, error?: Error & { code?: string }): GhResult => {
      const truncated = stdout.truncated || stderr.truncated;
      const truncationFailure =
        truncated && status === 0
          ? 'refusing truncated gh output because it may contain an incomplete protocol response'
          : '';
      return toGhResult({
        stdout: stdout.render(),
        stderr: stderr.render(truncationFailure),
        status: truncationFailure ? 1 : status,
        error,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('gh', [...args], { cwd, detached: true });
    } catch (error) {
      settle(outcome(null, error instanceof Error ? error : new Error(String(error))));
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.once('error', (error: Error & { code?: string }) => settle(outcome(null, error)));
    child.once('close', (code) => {
      if (timedOut) {
        const result = outcome(1);
        settle({
          ...result,
          stderr: stderr.render(`gh timed out after ${timeoutMs}ms`),
        });
        return;
      }
      settle(outcome(code));
    });

    deadline = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      let terminationDiagnostic = '';
      try {
        if (child.pid === undefined) terminationDiagnostic = '; child pid unavailable';
        else killTree(child.pid);
      } catch (error) {
        terminationDiagnostic = `; termination error: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      terminationDeadline = setTimeout(
        () =>
          settle({
            ...outcome(1),
            stderr: stderr.render(
              `gh timed out after ${timeoutMs}ms${terminationDiagnostic}; child exit was not confirmed`,
            ),
          }),
        Math.max(0, terminationGraceMs),
      );
    }, Math.max(0, timeoutMs));
  });

/** Extract the trailing PR number from a `gh` PR URL (…/pull/<n>). */
function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The `gh pr view --json` fields this reads. Everything is optional: it is gh's output, not ours. */
interface PrView {
  number?: unknown;
  url?: unknown;
  state?: unknown;
}

/**
 * The open PR for whatever branch is checked out in `cwd`, or null. Every ticket
 * works on its own worktree branch, so gh's branch-inferred lookup is exactly the
 * question ship asks: has this branch already been shipped?
 *
 * Null, never a throw — for "no PR" AND for every failure (bad auth, no remote,
 * unparseable output). This is a probe, not the operation: `openPr` runs next and
 * reports a real failure in gh's own words, so nothing is swallowed by answering
 * "no PR I can adopt" here.
 *
 * Only an OPEN PR counts. A closed or merged one does not block a new PR on the
 * same branch, and adopting it would strand the ticket on a PR nobody will merge
 * while skipping the create that should have happened.
 */
export async function findOpenPr(gh: GhRunner, cwd: string): Promise<OpenedPr | null> {
  const r = await gh(['pr', 'view', '--json', 'number,url,state'], cwd);
  if (r.exitCode !== 0) return null;

  let view: PrView;
  try {
    view = JSON.parse(r.stdout) as PrView;
  } catch {
    return null;
  }
  if (view.state !== 'OPEN' || typeof view.url !== 'string' || view.url === '') return null;

  const number = typeof view.number === 'number' ? view.number : prNumberFromUrl(view.url);
  return { url: view.url, number };
}

/**
 * The dashboard's PR vocabulary. A superset of gh's `state` (OPEN/CLOSED/MERGED)
 * because a draft — state OPEN with `isDraft` — earns its own label, and because
 * every failure to determine the true state must have a name the caller can
 * refuse to persist.
 */
export type PrStatus = 'open' | 'draft' | 'closed' | 'merged' | 'unknown';

/** The `gh pr view --json state,isDraft` fields — gh's output, so all optional. */
interface PrStateView {
  state?: unknown;
  isDraft?: unknown;
}

/**
 * Map gh's `state` (+ `isDraft`) onto the dashboard vocabulary. Anything gh never
 * emits — a future upstream status, a garbled row — is 'unknown', not guessed
 * into a known bucket: a wrong-but-confident status is worse than an honest one.
 */
export function normalizePrState(state: unknown, isDraft: unknown): PrStatus {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (state === 'OPEN') return isDraft === true ? 'draft' : 'open';
  return 'unknown';
}

/**
 * Current upstream state of a recorded PR, normalized. Queried by `ref` — a PR
 * URL or number — so it works for any stored PR without that branch being
 * checked out; `cwd` still points gh at a repo so it can resolve auth/host.
 *
 * 'unknown' on EVERY failure (bad auth, a PR deleted upstream, a dead remote,
 * unparseable output), never a throw. The sync caller reads 'unknown' as "keep
 * the last state we saw" — a probe that cannot see the PR must not overwrite a
 * real status with a guess (F4: no stale-or-wrong cached status).
 */
export async function fetchPrState(gh: GhRunner, ref: string, cwd: string): Promise<PrStatus> {
  const r = await gh(['pr', 'view', ref, '--json', 'state,isDraft'], cwd);
  if (r.exitCode !== 0) return 'unknown';

  let view: PrStateView;
  try {
    view = JSON.parse(r.stdout) as PrStateView;
  } catch {
    return 'unknown';
  }
  return normalizePrState(view.state, view.isDraft);
}

/**
 * Open a PR for one repo via `gh pr create`. MVP opens PRs independently with
 * no ordering (cross-repo merge ordering is out of scope). Throws on a nonzero
 * exit so a failed PR surfaces rather than silently producing an empty row.
 */
export async function openPr(gh: GhRunner, opts: OpenPrOpts): Promise<OpenedPr> {
  const args = ['pr', 'create', '--title', opts.title, '--body', opts.body];
  if (opts.base) args.push('--base', opts.base);

  const r = await gh(args, opts.cwd);
  if (r.exitCode !== 0) {
    // A runner may still hand back nothing (a custom one, or gh writing only to a
    // tty); fall back to the exit code so the message is never a bare colon.
    const reason = r.stderr?.trim() || r.stdout.trim() || `gh exit ${r.exitCode}`;
    throw new Error(`gh pr create failed in ${opts.cwd}: ${reason}`);
  }

  const url = r.stdout.trim();
  return { url, number: prNumberFromUrl(url) };
}
