import { spawnSync } from 'node:child_process';
import { GH_DEPENDENCY, renderMissingDependency } from '../runtime/deps.js';

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

/** What `spawnSync` hands back — narrowed to the fields the mapping below reads. */
interface SpawnOutcome {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error & { code?: string };
}

/**
 * Map a `spawnSync` outcome onto a `GhResult`, never losing the reason.
 *
 * When the spawn itself fails (gh not installed → ENOENT), `status` is null and
 * both pipes are null: gh never ran, so the ONLY account of what happened is
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

/** Default runner: `gh <args>` in `cwd`, inheriting the user's gh auth. */
export const defaultGhRunner: GhRunner = async (args, cwd) => {
  return toGhResult(spawnSync('gh', args, { cwd, encoding: 'utf8' }));
};

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
