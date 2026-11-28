import { describe, expect, it } from 'vitest';
import type { ShipPreview, ShipPreviewRepo } from '../../workflow/shipPreview.js';
import { withShipPreviewRows } from './shipPreviewRows.js';
import type { EvidenceRow, InsideProcessView } from './types.js';

const repo = (over: Partial<ShipPreviewRepo> & { repo: string }): ShipPreviewRepo => ({
  prTitle: `feat(${over.repo}): land the change`,
  commitMessage: `feat(${over.repo}): land the change`,
  commitFiles: [],
  excludedFiles: [],
  committedExcludedWarning: [],
  deny: [],
  prNumber: null,
  changedFromBase: true,
  branchCommits: [],
  branchCommitsMore: 0,
  status: 'will-commit',
  ...over,
});

const preview = (repos: ShipPreviewRepo[], computedAt = '2026-05-01T09:41:07.000Z'): ShipPreview => ({ computedAt, repos });

/** The four ship processes the preview can reach, each with the shape `shipProcesses()` emits before ship runs. */
const processes = (): InsideProcessView[] => [
  { id: 'commit', kind: 'commit', label: 'Commit', status: 'pending', evidence: { kind: 'commits', rows: [], total: 0 } },
  { id: 'push', kind: 'push', label: 'Push', status: 'pending', evidence: { kind: 'rows', rows: [] } },
  { id: 'pr', kind: 'pr', label: 'Pull request', status: 'pending', evidence: { kind: 'prs', rows: [], open: 0, merged: 0 } },
  { id: 'merge', kind: 'merge', label: 'Merge', status: 'pending' },
];

const identity = (repo: string): string | undefined => undefined;

const rowsOf = (out: InsideProcessView[], id: string): readonly EvidenceRow[] => out.find((p) => p.id === id)!.evidence!.rows;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

describe('withShipPreviewRows — the Commit rows', () => {
  it('states will commit with the message, then Files (N) and Commits (N) with their lists in the output', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({
          repo: 'web',
          commitFiles: ['src/app.ts', 'src/app.test.ts'],
          branchCommits: [{ sha: 'a1b2c3d', subject: 'feat(web): prior agent work' }],
        }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([
      { status: 'pending', label: 'web', detail: 'will commit — feat(web): land the change' },
      { status: 'pending', label: 'web', detail: 'Files (2)', output: 'src/app.ts\nsrc/app.test.ts' },
      { status: 'pending', label: 'web', detail: 'Commits (1)', output: 'a1b2c3d feat(web): prior agent work' },
    ]);
  });

  it('caps a long file list and names the remainder (UI-R32/R44)', () => {
    const files = Array.from({ length: 53 }, (_, i) => `src/file-${i}.ts`);
    const out = withShipPreviewRows(processes(), preview([repo({ repo: 'web', commitFiles: files })]), identity);
    const filesRow = rowsOf(out, 'commit').find((r) => r.detail === 'Files (53)')!;
    expect(filesRow.output!.split('\n')).toHaveLength(51); // 50 + the remainder line
    expect(filesRow.output!.endsWith('and 3 more')).toBe(true);
  });

  it('states nothing to commit with no change from base', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false }),
        repo({ repo: 'api' }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toContainEqual({
      status: 'pending',
      label: 'web',
      detail: 'nothing to commit — no changes from base',
    });
  });

  it('states the agent committed when the branch has changes of its own', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: true })]),
      identity,
    );
    expect(rowsOf(out, 'commit')[0]).toEqual({ status: 'pending', label: 'web', detail: 'nothing to commit — agent committed' });
  });

  it('counts the commits beyond the cap and names the remainder', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({
          repo: 'web',
          status: 'nothing-to-commit',
          changedFromBase: true,
          branchCommits: [{ sha: 'c123456', subject: 'feat: prior agent commit' }],
          branchCommitsMore: 5,
        }),
      ]),
      identity,
    );
    const commits = rowsOf(out, 'commit').find((r) => r.detail === 'Commits (6)')!;
    expect(commits.output).toBe('c123456 feat: prior agent commit\nand 5 more');
  });

  it('shows a blocked repository as a fail row with the refusal text, and never lists files it will not commit', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'blocked', deny: ['.env', 'id_rsa'], commitFiles: ['.env'] })]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([
      {
        status: 'fail',
        label: 'web',
        detail: 'ship refuses .env, id_rsa — commit them deliberately or ignore them',
      },
    ]);
  });

  it('falls back to the generic refusal when the deny scan named no path', () => {
    const out = withShipPreviewRows(processes(), preview([repo({ repo: 'web', status: 'blocked' })]), identity);
    expect(rowsOf(out, 'commit')[0]!.detail).toBe('ship refuses untracked secret-shaped files — commit them deliberately or ignore them');
  });

  it('shows a read failure as a fail row and claims no verdict', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false, error: 'git status exited 128' })]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([{ status: 'fail', label: 'web', detail: 'git status exited 128' }]);
  });

  it('names the excluded files and the committed-match warning', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({
          repo: 'web',
          commitFiles: ['src/app.ts'],
          excludedFiles: ['dist/bundle.js', 'dist/bundle.css'],
          committedExcludedWarning: ['dist/legacy.js'],
        }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([
      { status: 'pending', label: 'web', detail: 'will commit — feat(web): land the change' },
      { status: 'pending', label: 'web', detail: 'Files (1)', output: 'src/app.ts' },
      { status: 'pending', label: 'web', detail: 'Excluded (2) (ship.exclude)', output: 'dist/bundle.js\ndist/bundle.css' },
      {
        status: 'wait',
        label: 'web',
        detail: 'ship.exclude matches committed changes: dist/legacy.js — these DO ship',
      },
    ]);
  });

  it('warns once, first, when EVERY repository is genuinely unchanged (arch:SHIP-UNCHANGED)', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false }),
        repo({ repo: 'api', status: 'nothing-to-commit', changedFromBase: false }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([
      { status: 'fail', label: 'ship', detail: 'ship will fail — no repo has changes' },
      { status: 'pending', label: 'web', detail: 'nothing to commit — no changes from base' },
      { status: 'pending', label: 'api', detail: 'nothing to commit — no changes from base' },
    ]);
  });

  it('never warns when one repository has changes of its own', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false }),
        repo({ repo: 'api', status: 'nothing-to-commit', changedFromBase: true }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'commit')[0]!.label).toBe('web');
  });

  it('claims no push and no pull request when EVERY repository is genuinely unchanged (arch:SHIP-UNCHANGED)', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false }),
        repo({ repo: 'api', status: 'nothing-to-commit', changedFromBase: false }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'push')).toEqual([]);
    expect(rowsOf(out, 'pr')).toEqual([]);
  });

  it('claims no push and no pull request for one genuinely unchanged repository beside a changed one', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: false }),
        repo({ repo: 'api' }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'push').map((r) => r.label)).toEqual(['api']);
    expect(rowsOf(out, 'pr').map((r) => r.label)).toEqual(['api']);
  });

  it('still pushes a repository whose only changes the agent committed', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'nothing-to-commit', changedFromBase: true })]),
      identity,
    );
    expect(rowsOf(out, 'push')).toEqual([{ status: 'pending', label: 'web', detail: 'will push the branch' }]);
  });
});

describe('withShipPreviewRows — the Push and Pull request rows', () => {
  it('says what the push and the pull request will do', () => {
    const out = withShipPreviewRows(processes(), preview([repo({ repo: 'web' })]), identity);
    expect(rowsOf(out, 'push')).toEqual([{ status: 'pending', label: 'web', detail: 'will push the branch' }]);
    expect(rowsOf(out, 'pr')).toEqual([
      { status: 'pending', label: 'web', detail: 'will open — feat(web): land the change' },
    ]);
  });

  it('re-ship: pushes onto the open PR and never reports the repository as skipped (FIX-46)', () => {
    const out = withShipPreviewRows(processes(), preview([repo({ repo: 'web', prNumber: 42 })]), identity);
    expect(rowsOf(out, 'push')).toEqual([{ status: 'pending', label: 'web', detail: 'will push onto PR #42' }]);
    expect(rowsOf(out, 'pr')).toEqual([
      { status: 'pending', label: 'web', detail: 'PR #42 open — this commit is pushed onto it' },
    ]);
  });

  it('already shipped: states the open PR, and opens no pull request row', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'already-shipped', prNumber: 7 })]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([]);
    expect(rowsOf(out, 'push')).toEqual([{ status: 'note', label: 'web', detail: 'skipped — PR #7 open' }]);
    expect(rowsOf(out, 'pr')).toEqual([]);
  });

  it('already merged: states there is nothing to ship', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'already-merged', prNumber: 9 })]),
      identity,
    );
    expect(rowsOf(out, 'commit')).toEqual([]);
    expect(rowsOf(out, 'push')).toEqual([{ status: 'note', label: 'web', detail: 'nothing to ship — merged in #9' }]);
    expect(rowsOf(out, 'pr')).toEqual([]);
  });

  it('never invents a PR number the read did not resolve', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([repo({ repo: 'web', status: 'already-merged', prNumber: null })]),
      identity,
    );
    expect(rowsOf(out, 'push')[0]!.detail).toBe('nothing to ship — merged in #?');
  });

  it('names no push or pull request for a blocked or unread repository', () => {
    const out = withShipPreviewRows(
      processes(),
      preview([
        repo({ repo: 'web', status: 'blocked', deny: ['.env'] }),
        repo({ repo: 'api', error: 'git shortlog failed' }),
      ]),
      identity,
    );
    expect(rowsOf(out, 'push')).toEqual([]);
    expect(rowsOf(out, 'pr')).toEqual([]);
  });
});

describe('withShipPreviewRows — shape and purity', () => {
  it('prepends the will rows and keeps every recorded row behind them', () => {
    const recorded: InsideProcessView[] = processes();
    recorded[0]!.evidence = {
      kind: 'commits',
      rows: [{ status: 'pass', label: 'web', detail: '2 created · 1 before' }],
      total: 2,
      repos: [],
    } as never;
    const out = withShipPreviewRows(recorded, preview([repo({ repo: 'web' })]), identity);
    const commit = out.find((p) => p.id === 'commit')!;
    expect(commit.evidence!.rows.map((r) => r.detail)).toEqual([
      'will commit — feat(web): land the change',
      '2 created · 1 before',
    ]);
    expect(commit.evidence).toMatchObject({ kind: 'commits', leadRows: 1, total: 2 });
  });

  it('opens the processes that carry the will rows, so they are read before Confirm (D142)', () => {
    const out = withShipPreviewRows(processes(), preview([repo({ repo: 'web' })]), identity);
    expect(out.filter((p) => p.openByDefault).map((p) => p.id)).toEqual(['commit', 'push', 'pr']);
    expect(out.find((p) => p.id === 'merge')!.openByDefault).toBeUndefined();
  });

  it('returns new process objects and never mutates its inputs', () => {
    const input = processes();
    const data = deepFreeze(preview([repo({ repo: 'web', commitFiles: ['src/app.ts'] })]));
    deepFreeze(input);
    const before = JSON.stringify(input);
    const out = withShipPreviewRows(input, data, identity);
    expect(out).not.toBe(input);
    out.forEach((p, i) => expect(p).not.toBe(input[i]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('maps a repository to its manifest name through the injected resolver', () => {
    const out = withShipPreviewRows(processes(), preview([repo({ repo: '/wt/web' })]), (r) => (r === '/wt/web' ? 'web' : undefined));
    expect(rowsOf(out, 'commit')[0]!.label).toBe('web');
  });

  it('leaves the processes alone when the preview has no repositories', () => {
    const input = processes();
    const out = withShipPreviewRows(input, preview([]), identity);
    expect(out.map((p) => p.id)).toEqual(input.map((p) => p.id));
    expect(out.every((p) => !p.openByDefault)).toBe(true);
    expect(rowsOf(out, 'commit')).toEqual([]);
    expect(rowsOf(out, 'push')).toEqual([]);
    expect(rowsOf(out, 'pr')).toEqual([]);
  });

  it('tolerates a view that ships only some of the three processes', () => {
    const input: InsideProcessView[] = [
      { id: 'commit', kind: 'commit', label: 'Commit', status: 'pending', evidence: { kind: 'commits', rows: [] } },
    ];
    const out = withShipPreviewRows(input, preview([repo({ repo: 'web' })]), identity);
    expect(rowsOf(out, 'commit')).toHaveLength(1);
  });
});
