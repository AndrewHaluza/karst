import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { assertFixHasNewCommit, snapshotFixRoundHeads, NO_NEW_COMMIT_REASON } from './fixRoundGuard.js';
import type { GitRunner } from '../integrations/git.js';

const gitAt = (heads: Record<string, string>): GitRunner => async (args, cwd) =>
  args[0] === 'rev-parse' && cwd !== undefined && heads[cwd] !== undefined
    ? { exitCode: 0, stdout: `${heads[cwd]}\n`, stderr: '' }
    : { exitCode: 128, stdout: '', stderr: 'bad' };

describe('fix-round no-new-commit guard', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    for (const p of ['/wt/api', '/wt/web']) {
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)')
        .run(ticketId, p, p, 'b');
    }
    roundId = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: '2026-01-01T00:00:00Z',
    } as never).id;
  });

  it('refuses when every HEAD equals the recorded sha', async () => {
    const git = gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' });
    await snapshotFixRoundHeads(store, ticketId, roundId, git);
    await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow(NO_NEW_COMMIT_REASON);
  });

  it('accepts a new commit in a single repo', async () => {
    await snapshotFixRoundHeads(store, ticketId, roundId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' }));
    await expect(
      assertFixHasNewCommit(store, ticketId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w2' })),
    ).resolves.toBeUndefined();
  });

  it('allows the marker without a snapshot or when HEAD cannot be read', async () => {
    await expect(assertFixHasNewCommit(store, ticketId, gitAt({}))).resolves.toBeUndefined();
    await snapshotFixRoundHeads(store, ticketId, roundId, gitAt({ '/wt/api': 'a1' }));
    await expect(assertFixHasNewCommit(store, ticketId, gitAt({}))).resolves.toBeUndefined();
  });

  it('keeps the first snapshot on a re-nudge', async () => {
    await snapshotFixRoundHeads(store, ticketId, roundId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' }));
    await snapshotFixRoundHeads(store, ticketId, roundId, gitAt({ '/wt/api': 'a2', '/wt/web': 'w2' }));
    await expect(
      assertFixHasNewCommit(store, ticketId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' })),
    ).rejects.toThrow(/no new commit/);
  });
});
