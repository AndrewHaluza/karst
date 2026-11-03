import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import type { GitRunner } from '../integrations/git.js';
import {
  assertUiParityFresh,
  UI_PARITY_UPDATE_COMMAND,
  type ParityRunner,
} from './uiParityGuard.js';

const gitDiff = (files: string[]): GitRunner => async (args) => {
  if (args[0] === 'diff') return { exitCode: 0, stdout: files.join('\n') + '\n', stderr: '' };
  if (args[0] === 'merge-base') return { exitCode: 0, stdout: 'abc123\n', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};

describe('ui parity marker guard', () => {
  let store: Store;
  let ticketId: number;
  let runs: string[];
  const runner = (result: { ok: boolean; failures: string[] }): ParityRunner => async (cwd) => {
    runs.push(cwd);
    return result;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, '/wt/a', '/wt/a', 'b', 'develop');
    runs = [];
  });

  it('skips the parity run when no changed file is under src/ui', async () => {
    await expect(
      assertUiParityFresh(store, ticketId, gitDiff(['src/cli/stage.ts']), runner({ ok: false, failures: ['x'] })),
    ).resolves.toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('accepts when the parity run passes', async () => {
    await expect(
      assertUiParityFresh(store, ticketId, gitDiff(['src/ui/dashboard/a.ts']), runner({ ok: true, failures: [] })),
    ).resolves.toBeUndefined();
    expect(runs).toEqual(['/wt/a']);
  });

  it('refuses with the failing snapshot names and the update command', async () => {
    const p = assertUiParityFresh(
      store,
      ticketId,
      gitDiff(['src/ui/dashboard/a.ts']),
      runner({ ok: false, failures: ['regions · header'] }),
    );
    await expect(p).rejects.toThrow('regions · header');
    await expect(p).rejects.toThrow(UI_PARITY_UPDATE_COMMAND);
  });

  it('counts an untracked src/ui file as a UI change', async () => {
    const git: GitRunner = async (args) =>
      args[0] === 'ls-files'
        ? { exitCode: 0, stdout: 'src/ui/new.ts\n', stderr: '' }
        : { exitCode: 0, stdout: args[0] === 'diff' ? '\n' : 'abc\n', stderr: '' };
    await assertUiParityFresh(store, ticketId, git, runner({ ok: true, failures: [] }));
    expect(runs).toEqual(['/wt/a']);
  });

  it('allows the marker when the diff probe fails', async () => {
    const git: GitRunner = async () => ({ exitCode: 128, stdout: '', stderr: 'bad' });
    await expect(
      assertUiParityFresh(store, ticketId, git, runner({ ok: false, failures: ['x'] })),
    ).resolves.toBeUndefined();
    expect(runs).toEqual([]);
  });
});
