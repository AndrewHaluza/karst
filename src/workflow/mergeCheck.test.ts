import { describe, it, expect } from 'vitest';
import { checkMergeable } from './mergeCheck.js';
import type { GitRunner, GitResult } from '../integrations/git.js';

/**
 * Runner keyed by the git subcommand. `merge-tree` replies are keyed by their own
 * name so a test can script the probe without scripting the fetch/rev-parse
 * preamble it does not care about.
 */
function scriptedGit(
  replies: Record<string, Partial<GitResult>>,
): { git: GitRunner; seen: string[][] } {
  const seen: string[][] = [];
  const git: GitRunner = async (args) => {
    seen.push(args);
    const key = args.find((a) => !a.startsWith('-')) ?? args[0]!;
    const r = replies[key] ?? replies[args[0]!] ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { git, seen };
}

/** Preamble every scripted run needs: a fetch that works and two readable SHAs. */
const HEALTHY_PREAMBLE: Record<string, Partial<GitResult>> = {
  fetch: { exitCode: 0 },
  'rev-parse': { stdout: 'abc1234\n' },
};

describe('checkMergeable', () => {
  it('reports clean when merge-tree exits 0', async () => {
    const { git } = scriptedGit({ ...HEALTHY_PREAMBLE, 'merge-tree': { exitCode: 0 } });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('clean');
    expect(r.files).toEqual([]);
    expect(r.reason).toBeNull();
  });

  // Exit 1 is merge-tree's "conflicted", not an error. The paths are the payload —
  // without them the user has a verdict they cannot act on.
  it('reports conflicted with the conflicting paths when merge-tree exits 1', async () => {
    const { git } = scriptedGit({
      ...HEALTHY_PREAMBLE,
      'merge-tree': {
        exitCode: 1,
        stdout: '9f2c1a0b\n\nsrc/store/db.ts\nsrc/workflow/machine.ts\n',
      },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('conflicted');
    expect(r.files).toEqual(['src/store/db.ts', 'src/workflow/machine.ts']);
    expect(r.reason).toBeNull();
  });

  // The whole point of the three-valued result: a check that could not run must
  // never read as "no conflict". Defaulting to clean is the failure mode this
  // feature exists to prevent.
  it('reports unknown — never clean — when merge-tree fails outright', async () => {
    const { git } = scriptedGit({
      ...HEALTHY_PREAMBLE,
      'merge-tree': { exitCode: 128, stderr: 'fatal: not something we can merge' },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('unknown');
    expect(r.reason).toContain('fatal: not something we can merge');
    expect(r.files).toEqual([]);
  });

  // git < 2.38 has no `--write-tree`. Degrading to unknown with git's own words
  // beats mis-reporting, and tells the user exactly what to fix.
  it('reports unknown when git is too old to know --write-tree', async () => {
    const { git } = scriptedGit({
      ...HEALTHY_PREAMBLE,
      'merge-tree': { exitCode: 129, stderr: "error: unknown option `write-tree'" },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('unknown');
    expect(r.reason).toContain('write-tree');
  });

  it('reports unknown when the worktree has no base ref recorded', async () => {
    const { git, seen } = scriptedGit(HEALTHY_PREAMBLE);

    const r = await checkMergeable(git, '/wt/fe', null);

    expect(r.state).toBe('unknown');
    expect(r.reason).toMatch(/base ref/i);
    // Nothing was guessed: no git ran at all, least of all against `main`.
    expect(seen).toEqual([]);
  });

  // Measuring against a base the local clone last saw a week ago is how a stale
  // "clean" gets produced. If we cannot refresh the base, we do not have an answer.
  it('reports unknown when the base cannot be fetched', async () => {
    const { git } = scriptedGit({
      ...HEALTHY_PREAMBLE,
      fetch: { exitCode: 128, stderr: "fatal: couldn't find remote ref main" },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('unknown');
    expect(r.reason).toContain("couldn't find remote ref main");
  });

  it('reports unknown when a SHA cannot be resolved', async () => {
    const { git } = scriptedGit({
      fetch: { exitCode: 0 },
      'rev-parse': { exitCode: 128, stderr: 'fatal: ambiguous argument' },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('unknown');
    expect(r.reason).toContain('fatal: ambiguous argument');
  });

  // Exit 1 with output we cannot parse still means conflicted. Downgrading to
  // clean because the file list came back in an unexpected shape would turn a
  // parsing bug into a false all-clear.
  it('stays conflicted with an empty list when exit 1 yields no parsable paths', async () => {
    const { git } = scriptedGit({
      ...HEALTHY_PREAMBLE,
      'merge-tree': { exitCode: 1, stdout: '\n' },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('conflicted');
    expect(r.files).toEqual([]);
  });

  it('records the SHAs the verdict was computed from, for staleness', async () => {
    const { git } = scriptedGit({
      fetch: { exitCode: 0 },
      'rev-parse': { stdout: 'deadbee\n' },
      'merge-tree': { exitCode: 0 },
    });

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.headSha).toBe('deadbee');
    expect(r.baseSha).toBe('deadbee');
  });

  // Ship has no `failed` edge. A merge probe that throws would abort the stage and
  // park the ticket — an observability feature must not become a failure mode.
  it('never throws, even when the runner itself rejects', async () => {
    const git: GitRunner = async () => {
      throw new Error('runner exploded');
    };

    const r = await checkMergeable(git, '/wt/fe', 'main');

    expect(r.state).toBe('unknown');
    expect(r.reason).toContain('runner exploded');
  });

  it('probes the real remote-tracking base, not the local branch of the same name', async () => {
    const { git, seen } = scriptedGit({ ...HEALTHY_PREAMBLE, 'merge-tree': { exitCode: 0 } });

    await checkMergeable(git, '/wt/fe', 'main');

    expect(seen[0]).toEqual(['fetch', 'origin', 'main']);
    expect(seen).toContainEqual(['rev-parse', 'origin/main']);
  });
});
