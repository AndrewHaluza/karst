import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { listPrsByTicket } from '../../store/dashboard.js';
import { transition } from '../machine.js';
import { shipTicket } from './ship.js';
import { updateTicketStatus } from './done.js';
import { manualProvider } from '../../integrations/ticketing.js';
import type { GhRunner } from '../../integrations/github.js';
import type { AgentAdapter } from '../../agent/adapter.js';

function seedWorktree(store: Store, ticketId: number, repo: string, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, ?, 'karst/x', 'develop', 'inherited')`,
    )
    .run(ticketId, repo, path);
}

function walkToShip(store: Store, id: number): void {
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
  transition(store, id, 'review', { kind: 'passed' });
}

function fakeGh(): { gh: GhRunner; calls: number } {
  let calls = 0;
  const gh: GhRunner = async () => {
    calls++;
    return { stdout: `https://github.com/o/r/pull/${calls}`, exitCode: 0 };
  };
  return {
    gh,
    get calls() {
      return calls;
    },
  } as { gh: GhRunner; calls: number };
}

function fakeAdapter(): AgentAdapter {
  return {
    runHeadless: async () => ({ sessionId: 's', verdict: null, raw: 'Generated PR body.' }),
    buildInteractiveCommand: () => ({ command: 'claude', args: [], env: {} }),
    requiredBinary: 'claude',
    capabilities: { httpHooks: true, resume: true },
  };
}

describe('shipTicket', () => {
  let store: Store;
  let id: number;
  let dir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'PROJ-1', title: 'add search' }).id;
    dir = mkdtempSync(join(tmpdir(), 'karst-ship-'));
    walkToShip(store, id);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens one PR per hot repo and writes rows to prs', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    const { gh } = fakeGh();
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter());
    expect(res.prs).toHaveLength(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);
  });

  it('each PR carries an agent-generated description', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const gh: GhRunner = async (args) => {
      // body flag value is the generated prose
      const bodyIdx = args.indexOf('--body');
      expect(args[bodyIdx + 1]).toContain('Generated PR body');
      return { stdout: 'https://github.com/o/r/pull/9', exitCode: 0 };
    };
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter());
    expect(res.prs[0]!.url).toBe('https://github.com/o/r/pull/9');
  });

  it('advances the stage to done on success', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    const { gh } = fakeGh();
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter());
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  it('is idempotent — a re-run skips repos with an existing open PR (no duplicate)', async () => {
    seedWorktree(store, id, '/repo/frontend', join(dir, 'fe'));
    seedWorktree(store, id, '/repo/backend', join(dir, 'be'));
    let calls = 0;
    const gh: GhRunner = async () => {
      calls++;
      return { stdout: `https://github.com/o/r/pull/${calls}`, exitCode: 0 };
    };
    // First ship opens both PRs (2 gh calls).
    await shipTicket(store, { ticketId: id }, gh, fakeAdapter());
    expect(calls).toBe(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);

    // Re-run (crash-recovery re-drive): no new gh calls, no duplicate rows.
    const res = await shipTicket(store, { ticketId: id }, gh, fakeAdapter());
    expect(calls).toBe(2);
    expect(listPrsByTicket(store, id)).toHaveLength(2);
    expect(res.prs).toHaveLength(2);
  });
});

describe('updateTicketStatus', () => {
  it('updates via the injected provider (manual)', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'PROJ-2', title: 't' }).id;
    const provider = manualProvider();
    await updateTicketStatus(store, id, 'done', provider);
    expect(provider.updates).toEqual([{ key: 'PROJ-2', status: 'done' }]);
  });
});
