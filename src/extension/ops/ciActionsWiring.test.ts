import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { rebaseOnBaseAction, sendCiFailureAction, type CiActionsInput } from './ciActionsWiring.js';

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

function input(over: Partial<CiActionsInput> = {}): CiActionsInput {
  return {
    store, ticketId: id, artifactDir: dir,
    gh: vi.fn(async () => ({ stdout: `${SHA}\n`, exitCode: 0 })),
    git: vi.fn(async (args: readonly string[]) => ({ stdout: args[0] === 'rev-parse' ? 'orig\n' : '', stderr: '', exitCode: 0 })),
    sandbox: { hasUnsynced: vi.fn(async () => false), recreateNoSync: vi.fn(async () => {}) },
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
    const i = input({ sandbox: { hasUnsynced: vi.fn(async () => true), recreateNoSync: vi.fn(async () => {}) } });
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
