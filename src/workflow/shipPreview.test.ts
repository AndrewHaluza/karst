import { describe, it, expect } from 'vitest';
import { manifest, repo } from '../manifest/fixtures.js';
import type { PorcelainEntry } from '../integrations/git.js';
import {
  partitionPorcelainByExclude,
  parseBranchCommits,
  BRANCH_COMMITS_CAP,
  loadShipPreview,
  resolveShipArtifacts,
  resolveTemplateModel,
  type ShipArtifactTicket,
} from './shipPreview.js';
import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';

const ticket: ShipArtifactTicket = {
  type: null,
  model: null,
};

const entry = (path: string, from?: string): PorcelainEntry =>
  from === undefined ? { status: ' M', path } : { status: 'R ', path, from };

describe('partitionPorcelainByExclude', () => {
  it('splits a dirty set by the excluded paths, preserving git order', () => {
    const entries = [
      entry('src/a.ts'),
      entry('dist/out.js'),
      entry('src/b.ts'),
      entry('dist/nested/x.js'),
    ];
    const { commitFiles, excludedFiles } = partitionPorcelainByExclude(entries, [
      'dist/out.js',
      'dist/nested/x.js',
    ]);
    expect(commitFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(excludedFiles).toEqual(['dist/out.js', 'dist/nested/x.js']);
  });

  it('is identity when nothing is excluded', () => {
    expect(partitionPorcelainByExclude([entry('a'), entry('b')], []).commitFiles).toEqual(['a', 'b']);
    expect(partitionPorcelainByExclude([entry('a')], []).excludedFiles).toEqual([]);
  });

  it('commits the SOURCE deletion of a rename whose destination is excluded', () => {
    // `git mv to-move.txt dist/moved.txt` with `dist/**` excluded: the reset
    // restores the destination but the staged source deletion still lands.
    const { commitFiles, excludedFiles } = partitionPorcelainByExclude(
      [entry('dist/moved.txt', 'to-move.txt')],
      ['dist/moved.txt'],
    );
    expect(commitFiles).toEqual(['to-move.txt']);
    expect(excludedFiles).toEqual(['dist/moved.txt']);
  });

  it('commits nothing when BOTH ends of a rename are excluded', () => {
    const { commitFiles } = partitionPorcelainByExclude(
      [entry('dist/b.txt', 'dist/a.txt')],
      ['dist/a.txt', 'dist/b.txt'],
    );
    expect(commitFiles).toEqual([]);
  });

  it('commits the destination of a rename that moves OUT of an excluded dir', () => {
    const { commitFiles } = partitionPorcelainByExclude(
      [entry('outside.txt', 'dist/inside.txt')],
      ['dist/inside.txt'],
    );
    expect(commitFiles).toEqual(['outside.txt']);
  });
});

describe('resolveShipArtifacts', () => {
  it('falls back to the ticket title when no conventions configure a subject', () => {
    const artifacts = resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7,
      key: 'T7',
      title: 'fix the thing',
      repoName: 'extention',
      ticket,
    });
    expect(artifacts.commitMessage).toBe('fix the thing');
    expect(artifacts.prTitle).toBe('fix the thing');
    expect(artifacts.excludes).toEqual([]);
    expect(artifacts.context.repo).toBe('extention');
    expect(artifacts.context.scope).toBe('extention');
  });

  it('renders the repo override, then the global, then the default, per key', () => {
    const m = manifest(
      {
        alpha: repo({
          conventions: { pullRequestTitle: '[{scope}] {key} {title}' },
          ship: { exclude: ['dist/**'] },
        }),
      },
      { conventions: { commitMessage: '{type}: {title}' } },
    );
    const artifacts = resolveShipArtifacts({
      manifest: m,
      ticketId: 7,
      key: 'T7',
      title: 'Add ship preview',
      repoName: 'alpha',
      ticket: { ...ticket, type: 'feat' },
    });
    // commitMessage: no repo override → global.
    expect(artifacts.commitMessage).toBe('feat: Add ship preview');
    // pullRequestTitle: repo override wins.
    expect(artifacts.prTitle).toBe('[alpha] T7 Add ship preview');
    expect(artifacts.excludes).toEqual(['dist/**']);
    expect(artifacts.context.type).toBe('feat');
  });

  it('names the manifest repository ENTRY, never a local path', () => {
    const m = manifest({ alpha: repo({ repoPath: '/machine/secret/path' }) });
    const artifacts = resolveShipArtifacts({
      manifest: m,
      ticketId: 1,
      key: 'T1',
      title: 't',
      repoName: 'alpha',
      ticket,
    });
    expect(artifacts.context.repo).toBe('alpha');
  });

  it('reports the core and model that actually ran impl over manifest default', () => {
    const m = manifest({ extention: repo() }, { agentProvider: 'opencode2' });
    const ticketWithNullProviders: ShipArtifactTicket = {
      type: null,
      model: null,
      agentProvider: null,
      sessionProvider: null,
      agentPreset: null,
    };
    const withImpl = resolveShipArtifacts({
      manifest: m,
      ticketId: 901,
      key: 'T901',
      title: 'fix something',
      repoName: 'extention',
      ticket: ticketWithNullProviders,
      implRun: { provider: 'claude', model: 'claude-sonnet-5-5' },
    });
    expect(withImpl.context.provider).toBe('claude');
    expect(withImpl.context.model).toBe('claude-sonnet-5-5');

    const withoutImpl = resolveShipArtifacts({
      manifest: m,
      ticketId: 901,
      key: 'T901',
      title: 'fix something',
      repoName: 'extention',
      ticket: ticketWithNullProviders,
    });
    expect(withoutImpl.context.provider).toBe('opencode2');
    expect(withoutImpl.context.model).toBeUndefined();
  });
});

describe('resolveTemplateModel', () => {
  it('prefers the impl run model, then ticket override, then manifest default, then undefined', () => {
    expect(
      resolveTemplateModel({ model: 'opus' }, manifest({}), { model: 'claude-sonnet-5-5' }),
    ).toBe('claude-sonnet-5-5');
    expect(resolveTemplateModel({ model: 'opus' }, manifest({}))).toBe('opus');
    expect(
      resolveTemplateModel({ model: null }, manifest({}, { defaultModel: 'sonnet' })),
    ).toBe('sonnet');
    expect(resolveTemplateModel({ model: null }, manifest({}))).toBeUndefined();
    expect(resolveTemplateModel({ model: '   ' }, undefined)).toBeUndefined();
  });
});

describe('parseBranchCommits', () => {
  it('parses null-delimited sha and subject lines into commit objects', () => {
    const raw = ['abc1234\0feat: first commit', 'def5678\0fix: second commit'].join('\n');
    expect(parseBranchCommits(raw)).toEqual([
      { sha: 'abc1234', subject: 'feat: first commit' },
      { sha: 'def5678', subject: 'fix: second commit' },
    ]);
  });

  it('handles empty output cleanly', () => {
    expect(parseBranchCommits('')).toEqual([]);
    expect(parseBranchCommits('   \n  \n')).toEqual([]);
  });
});

describe('loadShipPreview branchCommits', () => {
  const makeMockStore = (): Store => {
    return {
      db: {
        prepare: (sql: string) => ({
          all: () => {
            if (sql.includes('FROM worktrees')) {
              return [
                {
                  ticket_id: 1,
                  repo: 'extention',
                  path: '/mock/repo',
                  branch: 'karst/feature',
                  base_ref: 'develop',
                  deps_mode: 'inherited',
                  created_at: '2026-01-01T00:00:00Z',
                },
              ];
            }
            return [];
          },
          get: () => {
            if (sql.includes('base_ref FROM worktrees')) {
              return { base_ref: 'develop' };
            }
            return undefined;
          },
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        }),
      },
    } as unknown as Store;
  };

  it('lists branchCommits for an agent-committed branch', async () => {
    const store = makeMockStore();
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'diff') {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'log') {
        expect(args).toEqual(['log', '--format=%h%x00%s', 'origin/develop..HEAD']);
        return {
          exitCode: 0,
          stdout: ['111aaaa\0feat: agent commit 1', '222bbbb\0fix: agent commit 2'].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const preview = await loadShipPreview({
      store,
      manifest: manifest({ extention: repo({ repoPath: '/mock/repo' }) }),
      git,
      ticketId: 1,
      key: 'T1',
      title: 'Test preview',
      ticket,
      implRun: null,
    });

    expect(preview.repos).toHaveLength(1);
    const r = preview.repos[0]!;
    expect(r.status).toBe('nothing-to-commit');
    expect(r.changedFromBase).toBe(true);
    expect(r.branchCommits).toEqual([
      { sha: '111aaaa', subject: 'feat: agent commit 1' },
      { sha: '222bbbb', subject: 'fix: agent commit 2' },
    ]);
    expect(r.branchCommitsMore).toBe(0);
  });

  it('caps branchCommits at BRANCH_COMMITS_CAP and computes branchCommitsMore', async () => {
    const store = makeMockStore();
    const commits = Array.from({ length: 25 }, (_, i) => `${i.toString(16).padStart(7, '0')}\0commit ${i}`);
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
      if (args[0] === 'diff') return { exitCode: 1, stdout: '', stderr: '' };
      if (args[0] === 'log') {
        return { exitCode: 0, stdout: commits.join('\n'), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const preview = await loadShipPreview({
      store,
      manifest: manifest({ extention: repo({ repoPath: '/mock/repo' }) }),
      git,
      ticketId: 1,
      key: 'T1',
      title: 'Test preview',
      ticket,
      implRun: null,
    });

    const r = preview.repos[0]!;
    expect(r.branchCommits).toHaveLength(BRANCH_COMMITS_CAP);
    expect(r.branchCommits[0]).toEqual({ sha: '0000000', subject: 'commit 0' });
    expect(r.branchCommitsMore).toBe(5);
  });

  it('uses origin/<baseRef> when baseRef is remote-only for branchCommits', async () => {
    const store = makeMockStore();
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') {
        if (args[2] === 'origin/develop^{commit}') return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
        if (args[2] === 'develop^{commit}') return { exitCode: 128, stdout: '', stderr: 'unknown revision' };
        return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
      }
      if (args[0] === 'diff') return { exitCode: 1, stdout: '', stderr: '' };
      if (args[0] === 'log') {
        expect(args[2]).toBe('origin/develop..HEAD');
        return { exitCode: 0, stdout: '111aaaa\0remote base commit', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const preview = await loadShipPreview({
      store,
      manifest: manifest({ extention: repo({ repoPath: '/mock/repo' }) }),
      git,
      ticketId: 1,
      key: 'T1',
      title: 'Test preview',
      ticket,
      implRun: null,
    });

    const r = preview.repos[0]!;
    expect(r.error).toBeUndefined();
    expect(r.branchCommits).toEqual([{ sha: '111aaaa', subject: 'remote base commit' }]);
  });

  it('routes git log failure to repo error without rejecting the preview', async () => {
    const store = makeMockStore();
    const git: GitRunner = async (args) => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' };
      if (args[0] === 'log') {
        return { exitCode: 128, stdout: '', stderr: 'fatal: ambiguous argument develop..HEAD' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const preview = await loadShipPreview({
      store,
      manifest: manifest({ extention: repo({ repoPath: '/mock/repo' }) }),
      git,
      ticketId: 1,
      key: 'T1',
      title: 'Test preview',
      ticket,
      implRun: null,
    });

    const r = preview.repos[0]!;
    expect(r.error).toBe('fatal: ambiguous argument develop..HEAD');
    expect(r.status).toBe('nothing-to-commit');
    expect(r.branchCommits).toEqual([]);
    expect(r.branchCommitsMore).toBe(0);
  });
});

describe('resolveShipArtifacts conventional prefix in the ticket title', () => {
  const conventions = { commitMessage: '{type}: {title}', pullRequestTitle: '{type}: {title}' };
  const render = (title: string, type: string | null = null, defaultType?: string) =>
    resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7,
      key: 'T7',
      title,
      repoName: 'extention',
      ticket: { ...ticket, type },
      conventions: { ...conventions, ...(defaultType ? { defaultType } : {}) },
    });

  it('takes the type from the title when the ticket has none', () => {
    const a = render('fix: Foo');
    expect(a.prTitle).toBe('fix: Foo');
    expect(a.commitMessage).toBe('fix: Foo');
    expect(a.context.title).toBe('Foo');
  });

  it('lets the stored ticket type win', () => {
    expect(render('fix: Foo', 'feat').prTitle).toBe('feat: Foo');
  });

  it('uses the default type for a title with no prefix', () => {
    expect(render('Foo').prTitle).toBe('feat: Foo');
    expect(render('Foo', null, 'chore').prTitle).toBe('chore: Foo');
  });

  it('drops the scope of a scoped prefix', () => {
    expect(render('fix(sbx): Foo').prTitle).toBe('fix: Foo');
  });

  it('does not treat an unknown word as a prefix', () => {
    expect(render('Ticket form: Foo').prTitle).toBe('feat: Ticket form: Foo');
  });

  it('keeps the raw title when no convention is set', () => {
    const a = resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7,
      key: 'T7',
      title: 'fix: Foo',
      repoName: 'extention',
      ticket,
    });
    expect(a.prTitle).toBe('fix: Foo');
    expect(a.commitMessage).toBe('fix: Foo');
  });
});
