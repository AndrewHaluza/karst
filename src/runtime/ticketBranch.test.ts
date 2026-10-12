import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import type { GitRunner } from '../integrations/git.js';
import {
  branchOwnedByLiveTicket,
  decideWorktreeBranch,
  resolveWorktreeBranch,
} from './ticketBranch.js';

// The exact branch T640's crashed push collided on: key + placeholder title.
const BRANCH = 'karst/fix/untitled-ticket-untitled-ticket';

function gitReturning(result: { stdout?: string; exitCode?: number }): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
  return { runner, calls };
}

describe('decideWorktreeBranch', () => {
  it('leaves the rendered branch alone when origin has no such ref', () => {
    expect(
      decideWorktreeBranch(BRANCH, 648, { remoteExists: false, ownedByLiveTicket: false }),
    ).toBe(BRANCH);
  });

  it('suffixes with the ticket id when origin has the ref and no live ticket owns it', () => {
    expect(
      decideWorktreeBranch(BRANCH, 648, { remoteExists: true, ownedByLiveTicket: false }),
    ).toBe(`${BRANCH}-t648`);
  });

  it('leaves the branch alone when a live ticket (a resume) already owns it', () => {
    expect(
      decideWorktreeBranch(BRANCH, 648, { remoteExists: true, ownedByLiveTicket: true }),
    ).toBe(BRANCH);
  });
});

describe('branchOwnedByLiveTicket', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  function own(ticketId: number, branch: string): void {
    store.db
      .prepare(
        'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ticketId, '/repo', `/repo/.karst/worktrees/w${ticketId}`, branch, 'develop');
  }

  it('is true for a branch carried by a live ticket, false for an unowned one', () => {
    const t = createTicketFlow(store, { key: 'X-1', title: 'x' });
    own(t.id, BRANCH);
    expect(branchOwnedByLiveTicket(store, BRANCH)).toBe(true);
    expect(branchOwnedByLiveTicket(store, 'karst/fix/other')).toBe(false);
  });

  it('is false once the owning ticket is archived', () => {
    const t = createTicketFlow(store, { key: 'X-2', title: 'x' });
    own(t.id, BRANCH);
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(t.id);
    expect(branchOwnedByLiveTicket(store, BRANCH)).toBe(false);
  });
});

describe('resolveWorktreeBranch', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('suffixes when origin already has the branch and no live ticket owns it', async () => {
    const { runner } = gitReturning({ stdout: `abc123\trefs/heads/${BRANCH}\n` });
    await expect(resolveWorktreeBranch(store, runner, ['/repo'], BRANCH, 648)).resolves.toBe(
      `${BRANCH}-t648`,
    );
  });

  it('leaves the branch alone when origin has no such ref', async () => {
    const { runner } = gitReturning({ stdout: '' });
    await expect(resolveWorktreeBranch(store, runner, ['/repo'], BRANCH, 648)).resolves.toBe(
      BRANCH,
    );
  });

  it('keeps the rendered branch and warns when ls-remote fails (offline/no origin)', async () => {
    const { runner } = gitReturning({ stdout: '', exitCode: 128 });
    const lines: string[] = [];
    const resolved = await resolveWorktreeBranch(store, runner, ['/repo'], BRANCH, 648, (m) =>
      lines.push(m),
    );
    expect(resolved).toBe(BRANCH);
    expect(lines.some((l) => l.includes('collision check') && l.includes(BRANCH))).toBe(true);
  });

  it('never probes origin when a live ticket already owns the branch (resume)', async () => {
    const t = createTicketFlow(store, { key: 'X-3', title: 'x' });
    store.db
      .prepare(
        'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
      )
      .run(t.id, '/repo', '/repo/.karst/worktrees/w3', BRANCH, 'develop');
    const { runner, calls } = gitReturning({ stdout: `abc\trefs/heads/${BRANCH}\n` });
    await expect(resolveWorktreeBranch(store, runner, ['/repo'], BRANCH, 648)).resolves.toBe(
      BRANCH,
    );
    expect(calls).toHaveLength(0);
  });
});
