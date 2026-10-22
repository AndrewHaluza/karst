import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { createUndeliveredTracker } from './deliverToPrOps.js';
import { deliverBlockedPrompt, deliverToPrAction, refreshUndeliveredForShipTickets, rebaseOnBaseAction, sendCiFailureAction, type CiActionsInput } from './ciActionsWiring.js';

const SHA = 'a'.repeat(40);
let store: Store;
let id: number;
let dir: string;

function seedPr(extra: { checks?: string | null; block?: string | null } = {}): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, merge_block, checks) VALUES (?, ?, 5, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r', 'https://github.com/o/r/pull/5', 'open', 'feat/x', 'develop', extra.block ?? 'behind', extra.checks ?? '{"state":"failing","total":1,"passed":0,"failed":1,"pending":0,"failedShown":1,"failing":[{"name":"lint","url":null}]}');
}

function sandbox(unsynced = false): CiActionsInput['sandbox'] {
  return {
    hasUnsynced: vi.fn(async () => unsynced), recreateNoSync: vi.fn(async () => {}),
    cloneRef: vi.fn(async () => null), ensureSynced: vi.fn(async () => ({ ok: true }) as never),
  };
}

function input(over: Partial<CiActionsInput> = {}): CiActionsInput {
  return {
    store, ticketId: id, artifactDir: dir,
    gh: vi.fn(async () => ({ stdout: `${SHA}\n`, exitCode: 0 })),
    git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? 'orig\n' : '', stderr: '', exitCode: 0 })),
    sandbox: sandbox(),
    deliver: { runShip: vi.fn(async () => {}), blocked: vi.fn(async () => {}), tracker: createUndeliveredTracker() },
    reprobe: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    info: vi.fn(), error: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(), afterServerChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'W-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  dir = mkdtempSync(join(tmpdir(), 'ci-wiring-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rebaseOnBaseAction', () => {
  it('tells the user when no PR is behind, and still refreshes', async () => {
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    expect(i.info).toHaveBeenCalledWith(expect.stringMatching(/not available/));
    expect(i.afterServerChange).toHaveBeenCalledOnce();
  });

  it('pushes with a lease on the head sha gh reports, then clears the probe, recreates and re-probes', async () => {
    seedPr();
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    const gitArgs = (i.git as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[]).join(' '));
    expect(gitArgs).toContain(`push --force-with-lease=feat/x:${SHA} origin HEAD:refs/heads/feat/x`);
    expect((i.git as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[1] === '/w/r')).toBe(true);
    expect(i.sandbox.recreateNoSync).toHaveBeenCalledWith(id);
    expect(i.reprobe).toHaveBeenCalledOnce();
    expect(store.db.prepare('SELECT checks, merge_block FROM prs').get()).toEqual({ checks: null, merge_block: null });
    expect(i.error).not.toHaveBeenCalled();
    expect(i.afterServerChange).toHaveBeenCalled();
  });

  it('refuses while the ticket agent is running, touching no git', async () => {
    seedPr();
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    const i = input();
    await rebaseOnBaseAction(i, () => []);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/agent is working/));
    expect(i.git).not.toHaveBeenCalled();
  });

  it('refuses while the sandbox has unsynced commits', async () => {
    seedPr();
    const i = input({ sandbox: sandbox(true) });
    await rebaseOnBaseAction(i, () => []);
    expect(i.sandbox.hasUnsynced).toHaveBeenCalledWith(id);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/sync or carry/));
    expect(i.git).not.toHaveBeenCalled();
  });

  it('reads the head of the PR by number and rejects a malformed sha before pushing', async () => {
    seedPr();
    const gh = vi.fn(async () => ({ stdout: 'not-a-sha', exitCode: 0 }));
    const i = input({ gh });
    await rebaseOnBaseAction(i, () => []);
    expect((gh.mock.calls as unknown as string[][][])[0]![0]).toEqual(['pr', 'view', '5', '--json', 'headRefOid', '--jq', '.headRefOid']);
    const gitArgs = (i.git as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as string[])[0]);
    expect(gitArgs).not.toContain('push');
    expect(i.error).toHaveBeenCalled();
    expect(i.sandbox.recreateNoSync).not.toHaveBeenCalled();
  });

  it('a git failure maps to the ops error path and never re-probes', async () => {
    seedPr();
    const git = vi.fn(async (args: readonly string[]) => ({ stdout: '', stderr: 'rejected', exitCode: args[0] === 'push' ? 1 : 0 }));
    const i = input({ git });
    await rebaseOnBaseAction(i, () => []);
    expect(i.error).toHaveBeenCalled();
    expect(i.reprobe).not.toHaveBeenCalled();
    expect(i.sandbox.recreateNoSync).not.toHaveBeenCalled();
  });
});

describe('sendCiFailureAction', () => {
  it('writes the log into the artifact dir and sends the ticket back with its path', async () => {
    seedPr({ block: null });
    const i = input();
    await sendCiFailureAction(i);
    const files = readFileSync(join(dir, `ci-failure-5.log`), 'utf8');
    expect(files).toContain('lint');
    expect(i.confirm).toHaveBeenCalledWith('Send CI failure to the agent?', expect.any(String), 'Send to agent');
    expect(i.drive).toHaveBeenCalled();
  });
});

describe('deliverToPrAction', () => {
  it('syncs, ships with the delivery flag seam, re-probes and refreshes the counts', async () => {
    seedPr();
    const i = input();
    const order: string[] = [];
    (i.sandbox.ensureSynced as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('sync'); return { ok: true }; });
    (i.deliver.runShip as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('ship'); });
    (i.reprobe as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('probe'); });
    await deliverToPrAction(i);
    expect(order).toEqual(['sync', 'ship', 'probe']);
    expect(i.afterServerChange).toHaveBeenCalled();
  });

  it('refuses while the agent runs, touching nothing', async () => {
    seedPr();
    store.db.prepare(`UPDATE tickets SET agent_state = 'running' WHERE id = ?`).run(id);
    const i = input();
    await deliverToPrAction(i);
    expect(i.error).toHaveBeenCalledWith(expect.stringMatching(/agent is working/));
    expect(i.sandbox.ensureSynced).not.toHaveBeenCalled();
    expect(i.deliver.runShip).not.toHaveBeenCalled();
  });
});

function projectOf(ticketId: number): number {
  const p = store.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number } | undefined;
  const pid = p?.id ?? Number(store.db.prepare(`INSERT INTO projects (name, slug) VALUES ('p', 'p')`).run().lastInsertRowid);
  store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(pid, ticketId);
  return pid;
}

describe('refreshUndeliveredForShipTickets', () => {
  it('measures ship tickets with an open PR and reports a change once', async () => {
    seedPr();
    const tracker = createUndeliveredTracker();
    const i = {
      store, projectId: 1, sandbox: { ...sandbox(), cloneRef: vi.fn(async () => 'FETCH_HEAD') },
      logError: vi.fn(),
      git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-list' ? '2\n' : '', stderr: '', exitCode: 0 })),
    };
    const pid = projectOf(id);
    expect(await refreshUndeliveredForShipTickets({ ...i, projectId: pid }, tracker)).toBe(true);
    expect(tracker.get(id)).toEqual({ hostAhead: 2, sandboxAhead: 2 });
    expect(await refreshUndeliveredForShipTickets({ ...i, projectId: pid }, tracker)).toBe(false);
  });

  it('logs and survives a failing read', async () => {
    seedPr();
    const logError = vi.fn();
    const pid = projectOf(id);
    const bad = { ...sandbox(), cloneRef: vi.fn(async () => { throw new Error('boom'); }) };
    expect(await refreshUndeliveredForShipTickets({ store, projectId: pid, sandbox: bad, logError, git: vi.fn() }, createUndeliveredTracker())).toBe(false);
    expect(logError).toHaveBeenCalled();
  });
});

describe('deliverBlockedPrompt', () => {
  it('opens the sync diff only when picked, naming the carry action for a rewritten clone', async () => {
    const open = vi.fn(async () => {});
    const warn = vi.fn(async (_m: string, ..._a: string[]) => 'Open sync diff' as string | undefined);
    await deliverBlockedPrompt(warn, open)('diverged', true);
    expect(warn.mock.calls[0]![0]).toMatch(/Nothing was pushed.*Carry sandbox commits/);
    expect(open).toHaveBeenCalledOnce();
    open.mockClear();
    await deliverBlockedPrompt(async () => undefined, open)('diverged', false);
    expect(open).not.toHaveBeenCalled();
  });
});
