import { spawnSync } from 'node:child_process';

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

/** Default runner: `gh <args>` in `cwd`, inheriting the user's gh auth. */
export const defaultGhRunner: GhRunner = async (args, cwd) => {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
};

/** Extract the trailing PR number from a `gh` PR URL (…/pull/<n>). */
function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
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
    throw new Error(`gh pr create failed in ${opts.cwd}: ${r.stderr || r.stdout}`);
  }

  const url = r.stdout.trim();
  return { url, number: prNumberFromUrl(url) };
}
