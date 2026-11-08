import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('records the new HEAD of the repo that moved as the round fix commit sha', async () => {
    await snapshotFixRoundHeads(store, ticketId, roundId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' }));
    await assertFixHasNewCommit(store, ticketId, gitAt({ '/wt/api': 'a1', '/wt/web': 'w2' }));
    const row = store.db.prepare('SELECT fix_commit_sha AS s FROM recovery_rounds WHERE id = ?').get(roundId) as { s: string | null };
    expect(row.s).toBe('w2');
  });

  it('leaves the fix commit sha null when no HEAD moved', async () => {
    const git = gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' });
    await snapshotFixRoundHeads(store, ticketId, roundId, git);
    await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow();
    const row = store.db.prepare('SELECT fix_commit_sha AS s FROM recovery_rounds WHERE id = ?').get(roundId) as { s: string | null };
    expect(row.s).toBeNull();
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
  describe('operator manifest change', () => {
    let dir: string;
    let manifestPath: string;
    const git = gitAt({ '/wt/api': 'a1', '/wt/web': 'w1' });
    const rowOf = () =>
      store.db.prepare('SELECT manifest_path AS p, manifest_sha AS s, fix_commit_sha AS c FROM recovery_rounds WHERE id = ?').get(roundId) as {
        p: string | null; s: string | null; c: string | null;
      };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'karst-fixguard-'));
      manifestPath = join(dir, 'karst.yml');
      writeFileSync(manifestPath, 'a: 1\n');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('records the manifest path and a sha256 of its bytes', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      const row = rowOf();
      expect(row.p).toBe(manifestPath);
      expect(row.s).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records NULL for no manifest or an unreadable file', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, join(dir, 'missing.yml'));
      expect(rowOf()).toMatchObject({ p: null, s: null });
    });

    it('accepts a changed manifest with unchanged HEADs and leaves fix_commit_sha null', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      writeFileSync(manifestPath, 'a: 2\n');
      await expect(assertFixHasNewCommit(store, ticketId, git)).resolves.toBeUndefined();
      expect(rowOf().c).toBeNull();
    });

    it('refuses an unchanged manifest and names both signals', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow(NO_NEW_COMMIT_REASON);
      await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow(/no new commit since this fix round started/);
      await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow(/a change to the manifest at /);
    });

    it('refuses when the recorded manifest became unreadable', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      rmSync(manifestPath);
      await expect(assertFixHasNewCommit(store, ticketId, git)).rejects.toThrow(NO_NEW_COMMIT_REASON);
    });

    it('keeps the first manifest snapshot on a re-nudge', async () => {
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      writeFileSync(manifestPath, 'a: 2\n');
      await snapshotFixRoundHeads(store, ticketId, roundId, git, manifestPath);
      await expect(assertFixHasNewCommit(store, ticketId, git)).resolves.toBeUndefined();
    });
  });
});
