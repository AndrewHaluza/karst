import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import type { GitRunner } from '../integrations/git.js';
import { assertDocsBlocksWithinCap, type DocsLintRunner } from './docsBlockGuard.js';

const gitDiff = (files: string[]): GitRunner => async (args) => {
  if (args[0] === 'diff') return { exitCode: 0, stdout: files.join('\n') + '\n', stderr: '' };
  if (args[0] === 'merge-base') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};

const OVER = 'docs/arch/a.md: arch:AP-00 exceeds 6400 B (7321); split the block';
const WARN = 'docs/arch/a.md: WARNING arch:AP-00 is 6000 B, above 90% of the 6400 B cap; split';

describe('docs block-size marker guard', () => {
  let store: Store;
  let ticketId: number;
  let runs: string[];
  const lint = (output: string): DocsLintRunner => async (cwd) => {
    runs.push(cwd);
    return output;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, '/wt/a', '/wt/a', 'b', 'develop');
    runs = [];
  });

  it('refuses when a changed docs file holds a block over the cap', async () => {
    const p = assertDocsBlocksWithinCap(store, ticketId, gitDiff(['docs/arch/a.md']), lint(OVER));
    await expect(p).rejects.toThrow(
      'cannot mark this stage done: docs/arch/a.md: arch:AP-00 exceeds 6400 B (7321); ' +
        'split the block (docs/arch/README.md @arch:DOC-01), then fire the marker',
    );
  });

  it('does not refuse for an over-cap file the ticket did not change', async () => {
    await expect(
      assertDocsBlocksWithinCap(store, ticketId, gitDiff(['docs/arch/other.md']), lint(OVER)),
    ).resolves.toBeUndefined();
  });

  it('does not run the lint when the ticket changed no docs file', async () => {
    await assertDocsBlocksWithinCap(store, ticketId, gitDiff(['src/cli/main.ts']), lint(OVER));
    expect(runs).toEqual([]);
  });

  it('does not refuse for a warning only', async () => {
    await expect(
      assertDocsBlocksWithinCap(store, ticketId, gitDiff(['docs/arch/a.md']), lint(WARN)),
    ).resolves.toBeUndefined();
    expect(runs).toEqual(['/wt/a']);
  });

  it('counts an untracked docs file as changed', async () => {
    const git: GitRunner = async (args) =>
      args[0] === 'ls-files'
        ? { exitCode: 0, stdout: 'docs/arch/a.md\n', stderr: '' }
        : { exitCode: 0, stdout: args[0] === 'diff' ? '\n' : 'abc\n', stderr: '' };
    await expect(assertDocsBlocksWithinCap(store, ticketId, git, lint(OVER))).rejects.toThrow('7321');
  });

  it('propagates a lint probe failure so the caller lets the marker through', async () => {
    const failing: DocsLintRunner = async () => {
      throw new Error('spawn error');
    };
    await expect(
      assertDocsBlocksWithinCap(store, ticketId, gitDiff(['docs/arch/a.md']), failing),
    ).rejects.toThrow('spawn error');
  });

  it('allows the marker when the diff probe fails', async () => {
    const git: GitRunner = async () => ({ exitCode: 128, stdout: '', stderr: 'bad' });
    await expect(assertDocsBlocksWithinCap(store, ticketId, git, lint(OVER))).resolves.toBeUndefined();
    expect(runs).toEqual([]);
  });
});
