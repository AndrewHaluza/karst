import type { GitRunner } from '../integrations/git.js';

/**
 * Can this ticket's branch still merge into the base it was cut from?
 *
 * Ship opens a PR and advances to `done` without ever asking, so a ticket could
 * finish carrying a PR nobody can merge — discovered by a human at merge time,
 * long after the session that had the context was gone.
 *
 * Deliberately three-valued. "We could not check" is NOT "no conflict": a probe
 * that fails and reports clean is worse than no probe at all, because it is
 * believed. Every failure — a dead remote, a missing ref, a timeout, a git too
 * old to know the command — lands on `unknown` carrying git's own words.
 *
 * Pure over the injected runner: no store, no vscode, no real repo in tests.
 */

export type MergeState = 'clean' | 'conflicted' | 'unknown';

export interface MergeCheck {
  state: MergeState;
  /** Conflicting paths. Non-empty only when `state` is 'conflicted'. */
  files: readonly string[];
  /** git's own message. Non-null only when `state` is 'unknown'. */
  reason: string | null;
  /** The SHAs the verdict was computed from; null when they could not be read. */
  headSha: string | null;
  baseSha: string | null;
}

const REMOTE = 'origin';

function unknown(reason: string, headSha: string | null = null, baseSha: string | null = null): MergeCheck {
  return { state: 'unknown', files: [], reason, headSha, baseSha };
}

/** git's own words, or a last-resort exit code — never a bare colon. */
function reasonFrom(stderr: string, stdout: string, exitCode: number): string {
  return stderr.trim() || stdout.trim() || `git exit ${exitCode}`;
}

/**
 * `merge-tree --write-tree --name-only` prints the tree OID on the first line,
 * the conflicted paths on the lines immediately after it, then a BLANK line, then
 * git's informational messages ("Auto-merging x", "CONFLICT (content): …").
 *
 * The OID and the paths are consecutive — there is no blank line between them —
 * so the sections are not uniformly blank-separated and cannot be split as if
 * they were. Reading section 1 of a blank-line split returned the informational
 * messages, which then travelled to the panel and into the "Resolve conflicts"
 * brief as if they were filenames.
 *
 * Parsed defensively — an unrecognised shape yields no paths, and the caller
 * keeps the `conflicted` verdict rather than downgrading to clean on a parsing
 * surprise.
 */
function parseConflictedPaths(stdout: string): string[] {
  // Drop the tree OID: it always heads the output and is never a path.
  const [, ...rest] = stdout.split('\n');
  const paths: string[] = [];
  for (const raw of rest) {
    const line = raw.trim();
    // The first blank line ends the file section; everything past it is prose.
    if (line.length === 0) break;
    paths.push(line);
  }
  return paths;
}

export async function checkMergeable(
  git: GitRunner,
  cwd: string,
  baseRef: string | null,
): Promise<MergeCheck> {
  // No base recorded means no question to ask. Guessing `main` would produce a
  // confident verdict about a branch the ticket was never cut from.
  if (!baseRef) return unknown('no base ref recorded for this worktree');

  try {
    // Refresh the base first. Measuring against whatever this clone last saw is
    // exactly how a stale "clean" is manufactured.
    const fetched = await git(['fetch', REMOTE, baseRef], cwd);
    if (fetched.exitCode !== 0) {
      return unknown(reasonFrom(fetched.stderr, fetched.stdout, fetched.exitCode));
    }

    const head = await git(['rev-parse', 'HEAD'], cwd);
    if (head.exitCode !== 0) {
      return unknown(reasonFrom(head.stderr, head.stdout, head.exitCode));
    }
    const base = await git(['rev-parse', `${REMOTE}/${baseRef}`], cwd);
    if (base.exitCode !== 0) {
      return unknown(reasonFrom(base.stderr, base.stdout, base.exitCode), head.stdout.trim());
    }

    const headSha = head.stdout.trim() || null;
    const baseSha = base.stdout.trim() || null;
    // rev-parse exited 0 but said nothing. Interpolating a null into the probe
    // would ask git about a ref named "null" and believe whatever came back.
    if (!headSha || !baseSha) {
      return unknown('git resolved no SHA for HEAD or the base', headSha, baseSha);
    }

    // `--write-tree` is the modern (git >= 2.38) real-merge mode, and it is
    // READ-ONLY: no working tree, no index, safe against a live agent worktree.
    // Exit 0 = clean, exit 1 = conflicts (paths on stdout), anything else = error.
    const probe = await git(['merge-tree', '--write-tree', '--name-only', baseSha, headSha], cwd);

    if (probe.exitCode === 0) {
      return { state: 'clean', files: [], reason: null, headSha, baseSha };
    }
    if (probe.exitCode === 1) {
      return {
        state: 'conflicted',
        files: parseConflictedPaths(probe.stdout),
        reason: null,
        headSha,
        baseSha,
      };
    }
    return unknown(reasonFrom(probe.stderr, probe.stdout, probe.exitCode), headSha, baseSha);
  } catch (err) {
    // Ship has no `failed` edge: a throw here would park the ticket at `ship` over
    // a probe that is only ever advisory. Every escape becomes `unknown` instead.
    return unknown(err instanceof Error ? err.message : String(err));
  }
}
