import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { transition } from '../workflow/machine.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { makeLaunchTracker, registerAutopilotCommands, startAutopilot, type AutopilotBindingDeps } from './autopilotBinding.js';
import { getAutopilotTicket } from '../store/autopilot.js';
import { sendCiFailureAction } from './ops/ciActionsWiring.js';

vi.mock('./ops/ciActionsWiring.js', () => ({ sendCiFailureAction: vi.fn(async () => {}) }));

const cfg = { enabled: true, conflicts: { policy: 'auto' as const, maxRounds: 5 }, ci: { policy: 'auto' as const, maxAttempts: 3, checks: [] } };

function rig(over: Partial<AutopilotBindingDeps> = {}) {
  const store = openStore(':memory:');
  const project = upsertProject(store, { slug: 'p' });
  const id = createTicket(store, { key: 'AP-1', title: 't', projectId: project.id }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
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

describe('autopilot round guards (review)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks a conflict round as launching so its launch fails closed, then unmarks it', async () => {
    const roundLaunching = vi.fn();
    const r = rig({ roundLaunching });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(roundLaunching).toHaveBeenCalledWith(r.id, true);
    r.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(roundLaunching).toHaveBeenLastCalledWith(r.id, false);
    handle.dispose();
  });

  it('parks a conflict round as paused and spends no attempt when the dependency setup failed', async () => {
    const r = rig({ envBlocker: async () => 'dependency setup failed' });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(getAutopilotTicket(r.deps.store, r.id).stoppedReason).toBe('auto-fix paused: sandbox dependency setup failed');
  });

  it('leaves a ticket that waits for Confirm ship (no awaiting-merge block) alone', async () => {
    const r = rig();
    r.deps.store.db.prepare("UPDATE stages SET blocked_kind = NULL, blocked_reason = NULL, blocked_at = NULL WHERE ticket_id = ? AND stage_key = 'ship'").run(r.id);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(r.roundInput).not.toHaveBeenCalled();
  });
});

describe('conflict round outcomes (mutation)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a sent conflict round keeps the cooldown and the lease, and reads the launch record once', async () => {
    const takeLaunch = vi.fn(() => undefined);
    const r = rig({ takeLaunch });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    r.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(takeLaunch).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.roundInput).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('a failed conflict launch frees the ticket (no cooldown) and pauses with the launch reason', async () => {
    const r = rig({ takeLaunch: async () => ({ kind: 'failed', reason: 'no terminal' }) });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    r.release();
    await vi.advanceTimersByTimeAsync(0);
    handle.dispose();
    expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toBe('auto-fix paused: sandbox session launch failed: no terminal');
  });

  it('a refused conflict round (no brief) frees the ticket for the next sweep', async () => {
    const r = rig();
    r.roundInput.mockImplementation((() => ({
      repo: 'r', label: 'AP-1', probeSandbox: async () => ({ state: 'absent' as const }), briefFor: () => null,
      notify: () => {}, deliver: () => {},
    })) as never);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    handle.dispose();
    expect(r.roundInput).toHaveBeenCalledTimes(1);
    const until = r.deps.store.db.prepare('SELECT claim_until AS u FROM autopilot_tickets WHERE ticket_id = ?').get(r.id) as { u: number };
    expect(until.u - Date.now()).toBeLessThan(60_000);
  });

  it('starts no round when another window holds the lease', async () => {
    const r = rig();
    r.deps.store.db.prepare("INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)").run(r.id);
    r.deps.store.db.prepare("UPDATE autopilot_tickets SET claim_owner = 'OTHER', claim_until = 99999999999999 WHERE ticket_id = ?").run(r.id);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(r.roundInput).not.toHaveBeenCalled();
  });
});

describe('registerAutopilotCommands pickers (mutation)', () => {
  it('logs a command message with the ship prefix and maps the pickers', async () => {
    const handlers = new Map<string, (...a: never[]) => unknown>();
    const showQuickPick = vi.fn(async (items: readonly unknown[]) => items[0]);
    const host = {
      commands: { registerCommand: (c: string, h: (...a: never[]) => unknown) => { handlers.set(c, h); return { dispose() {} }; } },
      window: { showQuickPick },
    };
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-7', title: 't', projectId: project.id }).id;
    const debug = vi.fn();
    registerAutopilotCommands(host as never, { store, projectId: () => project.id, debug, stopSession: async () => {} });
    await (handlers.get('karst.autopilot.setOverride') as (a?: number, b?: string) => Promise<unknown>)(id, 'on');
    expect(debug.mock.calls.some((c) => String(c[0]).startsWith('[ship] autopilot command:'))).toBe(true);
    expect(getAutopilotTicket(store, id).mode).toBe('on');
  });
});

describe('CI round outcomes (mutation)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); vi.mocked(sendCiFailureAction).mockImplementation(async () => {}); });
  afterEach(() => vi.useRealTimers());
  const ciCfg = { ...cfg, ci: { policy: 'auto' as const, maxAttempts: 3, checks: ['build'] } };
  function ciRig(over: Partial<AutopilotBindingDeps> = {}) {
    const r = rig({ manifest: () => ({ autopilot: ciCfg }) as never, ciInput: (() => ({ store: undefined as never, ticketId: 0, debug: () => {}, handOff: () => null })) as never, ...over });
    const { store, ticketId } = { store: r.deps.store, ticketId: r.id };
    store.db.prepare("UPDATE merge_checks SET state = 'clean' WHERE ticket_id = ?").run(ticketId);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify({ state: 'failing', total: 2, passed: 1, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: null }] }), ticketId);
    (r.deps as { ciInput: unknown }).ciInput = (id: number) => ({ store, ticketId: id, debug: () => {}, handOff: () => null });
    return r;
  }

  it('a sent CI round keeps the cooldown and fails closed while it runs', async () => {
    const roundLaunching = vi.fn();
    const r = ciRig({ roundLaunching });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
    expect(roundLaunching.mock.calls).toEqual([[r.id, true], [r.id, false]]);
  });

  it('a failed CI hand-off frees the ticket (short lease, no cooldown)', async () => {
    vi.mocked(sendCiFailureAction).mockImplementation(async (i) => { i.error('gh down'); });
    const r = ciRig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    const until = r.deps.store.db.prepare('SELECT claim_until AS u FROM autopilot_tickets WHERE ticket_id = ?').get(r.id) as { u: number };
    expect(until.u - Date.now()).toBeLessThan(60_000);
  });

  it('a failed session launch after the CI hand-off pauses the engine with the launch reason', async () => {
    const r = ciRig({ takeLaunch: async () => ({ kind: 'failed', reason: 'no terminal' }) });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toBe('auto-fix paused: sandbox session launch failed: no terminal');
  });

  it('an environment blocker pauses the CI round before the hand-off and spends no attempt', async () => {
    const r = ciRig({ envBlocker: async () => 'dependency setup failed' });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
    expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toBe('auto-fix paused: sandbox dependency setup failed');
  });

  it('reads the setup state file when no envBlocker is injected', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'ap-setup-')), '1.setup.json');
    writeFileSync(file, '{"status":"failed"}');
    vi.useRealTimers();
    const r = ciRig({ setupStateFile: () => file, intervalMs: 20 });
    const handle = startAutopilot(r.deps);
    await vi.waitFor(() => expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toBe('auto-fix paused: sandbox dependency setup failed'));
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });
});

describe('round bookkeeping (mutation)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); vi.mocked(sendCiFailureAction).mockImplementation(async () => {}); });
  afterEach(() => vi.useRealTimers());
  const ciCfg = { ...cfg, ci: { policy: 'auto' as const, maxAttempts: 5, checks: ['build'] } };
  function ciRig(over: Partial<AutopilotBindingDeps> = {}) {
    const r = rig({ manifest: () => ({ autopilot: ciCfg }) as never, ...over });
    const { store } = r.deps;
    store.db.prepare("UPDATE merge_checks SET state = 'clean' WHERE ticket_id = ?").run(r.id);
    store.db.prepare('UPDATE prs SET checks = ? WHERE ticket_id = ?').run(JSON.stringify({ state: 'failing', total: 2, passed: 1, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: null }] }), r.id);
    (r.deps as { ciInput: unknown }).ciInput = (id: number) => ({ store, ticketId: id, debug: () => {}, handOff: () => null });
    return r;
  }
  const lease = (r: { deps: AutopilotBindingDeps; id: number }) =>
    (r.deps.store.db.prepare('SELECT claim_until AS u FROM autopilot_tickets WHERE ticket_id = ?').get(r.id) as { u: number }).u - Date.now();

  it('a sent round holds the long round lease', async () => {
    const r = ciRig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(lease(r)).toBeGreaterThan(100_000);
  });

  it('a failed hand-off shrinks the lease to a few intervals', async () => {
    vi.mocked(sendCiFailureAction).mockImplementation(async (i) => { i.error('gh down'); });
    const r = ciRig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lease(r)).toBeGreaterThan(2000);
    expect(lease(r)).toBeLessThan(4000);
    handle.dispose();
  });

  it('a launch record that is not a failure does not pause the engine', async () => {
    const r = ciRig({ takeLaunch: async () => ({ kind: 'launched' }) as never });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(getAutopilotTicket(r.deps.store, r.id).pausedReason).toBeNull();
  });

  it('starts no CI round when another window holds the lease', async () => {
    const r = ciRig();
    r.deps.store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)').run(r.id);
    r.deps.store.db.prepare("UPDATE autopilot_tickets SET claim_owner = 'OTHER', claim_until = 99999999999999 WHERE ticket_id = ?").run(r.id);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });

  it('does not start a second round during the cooldown and runs another once it ends', async () => {
    const r = ciRig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});

describe('command pickers (mutation)', () => {
  it('passes the placeholder and returns the picked ticket id and the picked choice', async () => {
    const handlers = new Map<string, (...a: never[]) => unknown>();
    const showQuickPick = vi.fn(async (items: readonly unknown[]) => items[0]);
    const host = {
      commands: { registerCommand: (c: string, h: (...a: never[]) => unknown) => { handlers.set(c, h); return { dispose() {} }; } },
      window: { showQuickPick },
    };
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-8', title: 't', projectId: project.id }).id;
    registerAutopilotCommands(host as never, { store, projectId: () => project.id, debug: () => {}, stopSession: async () => {} });
    await (handlers.get('karst.autopilot.setOverride') as () => Promise<unknown>)();
    const calls = showQuickPick.mock.calls as unknown as Array<[unknown[], { placeHolder: string }]>;
    expect(calls[0]![1].placeHolder).toBe('Set auto-fix mode for which ticket?');
    expect(calls[1]![1].placeHolder).toBe('Auto-fix mode');
    expect(getAutopilotTicket(store, id).mode).toBe(calls[1]![0][0]);
  });
});
