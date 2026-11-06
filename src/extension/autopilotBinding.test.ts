import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { transition } from '../workflow/machine.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { makeLaunchTracker, registerAutopilotCommands, startAutopilot, type AutopilotBindingDeps } from './autopilotBinding.js';
import { getAutopilotTicket } from '../store/autopilot.js';

const cfg = { enabled: true, conflicts: { policy: 'auto' as const, maxRounds: 5 }, ci: { policy: 'auto' as const, maxAttempts: 3, checks: [] } };

function rig(over: Partial<AutopilotBindingDeps> = {}) {
  const store = openStore(':memory:');
  const project = upsertProject(store, { slug: 'p' });
  const id = createTicket(store, { key: 'AP-1', title: 't', projectId: project.id }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w', 'b');
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 5, ?, ?)').run(id, 'r', 'https://github.com/o/r/pull/5', 'open');
  setMergeCheck(store, { ticketId: id, repo: 'r', state: 'conflicted', files: [], reason: null, headSha: 'h', baseSha: 'b1', baseRef: 'develop', checkedAt: 'x' });
  let release: () => void = () => {};
  const arm = vi.fn();
  const roundInput = vi.fn(() => ({
    repo: 'r', label: 'AP-1', probeSandbox: async () => ({ state: 'absent' as const }), briefFor: () => 'brief',
    arm, prepareSandbox: async () => ({ ok: true }), notify: () => {}, deliver: () => new Promise<void>((r) => { release = r; }),
  }) as never);
  const deps: AutopilotBindingDeps = {
    store, projectId: () => project.id, manifest: () => ({ autopilot: cfg }) as never, caps: () => ({ perParent: 2, total: 4 }),
    debug: vi.fn(), changed: vi.fn(), intervalMs: 1000, windowId: 'W', isLive: () => false, roundInput, ciInput: vi.fn() as never, takeLaunch: () => undefined, ...over,
  };
  return { deps, roundInput, id, release: () => release() };
}

describe('startAutopilot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a sweep per interval, and stops on dispose', async () => {
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.roundInput).toHaveBeenCalledTimes(1);
    handle.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.roundInput).toHaveBeenCalledTimes(1);
  });

  it('does not start a round while the sessions capability is missing', async () => {
    const r = rig({ canLaunch: () => false });
    startAutopilot(r.deps).dispose();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(r.roundInput).not.toHaveBeenCalled();
  });

  it('leaves a ticket alone during the cooldown after a round was sent', async () => {
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.roundInput).toHaveBeenCalledTimes(1);
    r.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.roundInput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(r.roundInput).toHaveBeenCalledTimes(2);
    handle.dispose();
  });
});

describe('a failed session launch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('parks the ticket and starts no cooldown', async () => {
    const r = rig({ takeLaunch: async () => ({ kind: 'failed', reason: 'sandbox is read-only' }) });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    r.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toContain('sandbox is read-only');
    handle.dispose();
  });
});

describe('a running session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([
    ['another window runs it (database says running)', false],
    ['this window runs it', true],
  ])('arms nothing when %s', async (_name, live) => {
    const r = rig({ isLive: () => live });
    r.deps.store.db.prepare("UPDATE tickets SET agent_state = 'running' WHERE id = ?").run(r.id);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(r.roundInput).not.toHaveBeenCalled();
  });
  it('arms nothing when this window holds a live session whose state is not yet running', async () => {
    const r = rig({ isLive: () => true });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(r.roundInput).not.toHaveBeenCalled();
  });
});

describe('registerAutopilotCommands', () => {
  it('registers the three commands', () => {
    const names: string[] = [];
    const host = {
      commands: { registerCommand: (c: string) => { names.push(c); return { dispose() {} }; } },
      window: { showInformationMessage: vi.fn(), showQuickPick: vi.fn() },
    };
    const out = registerAutopilotCommands(host as never, { store: openStore(':memory:'), projectId: () => undefined, debug: () => {}, stopSession: async () => {} });
    expect(host.window.showInformationMessage).not.toHaveBeenCalled();
    expect(names).toEqual(['karst.autopilot.setOverride', 'karst.autopilot.approveOne', 'karst.autopilot.stop']);
    expect(out).toHaveLength(3);
  });
});

describe('two windows on one database', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('only one window arms the round', async () => {
    const a = rig({ windowId: 'A' });
    const b = rig({ windowId: 'B', store: a.deps.store, projectId: a.deps.projectId });
    const ha = startAutopilot(a.deps);
    const hb = startAutopilot(b.deps);
    await vi.advanceTimersByTimeAsync(1000);
    ha.dispose(); hb.dispose();
    expect(a.roundInput.mock.calls.length + b.roundInput.mock.calls.length).toBe(1);
  });
  it('the other window stays out during the cooldown of the sending window', async () => {
    const a = rig({ windowId: 'A' });
    const b = rig({ windowId: 'B', store: a.deps.store, projectId: a.deps.projectId });
    const ha = startAutopilot(a.deps);
    await vi.advanceTimersByTimeAsync(1000);
    a.release();
    const hb = startAutopilot(b.deps);
    await vi.advanceTimersByTimeAsync(60_000);
    ha.dispose(); hb.dispose();
    expect(a.roundInput).toHaveBeenCalledTimes(1);
    expect(b.roundInput).not.toHaveBeenCalled();
  });
});

describe('makeLaunchTracker', () => {
  it('passes failClosed only while an autopilot round marks the ticket', async () => {
    const execute = vi.fn(async () => ({ kind: 'launched' as const }));
    const t = makeLaunchTracker(execute);
    t.open(1, 'p', 'r');
    t.markRound(1, true);
    t.open(1, 'p', 'r');
    t.markRound(1, false);
    t.open(1, 'p', 'r');
    expect(execute.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { seedPrompt: 'p', seedRepo: 'r' }, { seedPrompt: 'p', seedRepo: 'r', failClosed: true }, { seedPrompt: 'p', seedRepo: 'r' },
    ]);
  });
  it('hands out a launch once, and turns a rejected launch into a failed outcome', async () => {
    const t = makeLaunchTracker(async () => { throw new Error('boom'); });
    expect(t.take(1)).toBeUndefined();
    t.open(1, 'p', 'r');
    expect(await t.take(1)).toEqual({ kind: 'failed', reason: 'boom' });
    expect(t.take(1)).toBeUndefined();
  });
});
