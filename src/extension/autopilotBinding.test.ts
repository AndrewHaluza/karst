import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { clearStageBlock, parkGateStage, stageBlock } from '../store/stageBlocks.js';
import { transition } from '../workflow/machine.js';
import { makeHostTicketCheck, makeLaunchTracker, makeSessionOwnerSync, makeStopSession, registerAutopilotCommands, stableWindowId, startAutopilot, type AutopilotBindingDeps } from './autopilotBinding.js';
import { getAutopilotSessionOwner, getAutopilotTicket, syncAutopilotSessionOwner } from '../store/autopilot.js';
import { sendCiFailureAction } from './ops/ciActionsWiring.js';

vi.mock('./ops/ciActionsWiring.js', () => ({ sendCiFailureAction: vi.fn(async () => {}) }));

const cfg = { enabled: true, ci: { policy: 'auto' as const, maxAttempts: 5, checks: ['build'] } };
const FAILING = { state: 'failing', total: 2, passed: 1, failed: 1, pending: 0, failedShown: 1, failing: [{ name: 'build', url: null }] };

/** A ship ticket with an open PR whose `build` check fails, and a parked awaiting-merge block. */
function rig(over: Partial<AutopilotBindingDeps> = {}) {
  const store = openStore(':memory:');
  const project = upsertProject(store, { slug: 'p' });
  const id = createTicket(store, { key: 'AP-1', title: 't', projectId: project.id }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
  parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked: not merged yet', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w', 'b');
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, 5, ?, ?, ?)').run(id, 'r', 'https://github.com/o/r/pull/5', 'open', JSON.stringify(FAILING));
  const debug = vi.fn();
  const deps: AutopilotBindingDeps = {
    store, projectId: () => project.id, manifest: () => ({ autopilot: cfg }) as never, caps: () => ({ perParent: 2, total: 4 }),
    debug, changed: vi.fn(), intervalMs: 1000, windowId: 'W', isLive: () => false,
    ciInput: (ticketId: number) => ({ store, ticketId, debug: () => {}, handOff: () => null }) as never,
    takeLaunch: () => undefined, isHostTicket: async () => true, ...over,
  };
  return { deps, store, id, debug };
}

const lease = (r: { store: ReturnType<typeof openStore>; id: number }): number =>
  (r.store.db.prepare('SELECT claim_until AS u FROM autopilot_tickets WHERE ticket_id = ?').get(r.id) as { u: number }).u - Date.now();

describe('startAutopilot', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); vi.mocked(sendCiFailureAction).mockImplementation(async () => {}); });
  afterEach(() => vi.useRealTimers());

  it('runs a CI round per interval, and stops on dispose', async () => {
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
    handle.dispose();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
  });

  it('does not start a round while the sessions capability is missing', async () => {
    const r = rig({ canLaunch: () => false });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });

  it('starts no round when another window holds the lease', async () => {
    const r = rig();
    r.store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)').run(r.id);
    r.store.db.prepare("UPDATE autopilot_tickets SET claim_owner = 'OTHER', claim_until = 99999999999999 WHERE ticket_id = ?").run(r.id);
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });

  it('does not start a second round in the cooldown, and runs another once it ends', async () => {
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('leaves a ticket that waits for Confirm ship (no awaiting-merge block) alone', async () => {
    const r = rig();
    clearStageBlock(r.store, r.id, 'ship');
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(3000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });
});

describe('a sandboxed ticket or an unknown placement', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['sandboxed', async () => false],
    ['unknown', async () => { throw new Error('probe failed'); }],
  ])('runs no round for a %s ticket and parks it with the required reason', async (_n, isHostTicket) => {
    const r = rig({ isHostTicket });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(sendCiFailureAction).not.toHaveBeenCalled();
    expect(stageBlock(r.store, r.id, 'ship')?.reason).toBe('auto-fix not run: sandboxed ticket');
    expect(r.store.db.prepare('SELECT COUNT(*) AS n FROM autopilot_budgets').get()).toEqual({ n: 0 });
  });
});

describe('a session launch', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); vi.mocked(sendCiFailureAction).mockImplementation(async () => {}); });
  afterEach(() => vi.useRealTimers());

  it('that failed parks the ticket with the launch reason and refunds the attempt', async () => {
    const r = rig({ takeLaunch: async () => ({ kind: 'failed', reason: 'no seat' }) as never });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(stageBlock(r.store, r.id, 'ship')?.reason).toBe('auto-fix stopped: ci could not run (session launch failed: no seat)');
    expect(r.store.db.prepare('SELECT attempts FROM autopilot_budgets').get()).toEqual({ attempts: 0 });
  });

  it.each(['cancelled', 'graph-owned', 'recovery'] as const)('that was queued or not applicable (%s) is not a failure', async (reason) => {
    const r = rig({ takeLaunch: async () => ({ kind: 'not-applicable', reason }) as never });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(getAutopilotTicket(r.store, r.id).pausedReason).toBeNull();
    expect(lease(r)).toBeGreaterThan(100_000);
  });

  it('that launched keeps the long round lease', async () => {
    const r = rig({ takeLaunch: async () => ({ kind: 'launched' }) as never });
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(getAutopilotTicket(r.store, r.id).pausedReason).toBeNull();
    expect(lease(r)).toBeGreaterThan(100_000);
  });

  it('whose hand-off failed shrinks the lease to a few intervals', async () => {
    vi.mocked(sendCiFailureAction).mockImplementation(async (i) => { i.error('gh down'); });
    const r = rig();
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
    expect(lease(r)).toBeGreaterThan(2000);
    expect(lease(r)).toBeLessThan(4000);
  });
});

describe('who holds the session', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendCiFailureAction).mockReset(); vi.mocked(sendCiFailureAction).mockImplementation(async () => {}); });
  afterEach(() => vi.useRealTimers());
  const sweepOnce = async (r: ReturnType<typeof rig>): Promise<void> => {
    const handle = startAutopilot(r.deps);
    await vi.advanceTimersByTimeAsync(1000);
    handle.dispose();
  };
  const setAgent = (r: ReturnType<typeof rig>, state: string): void => {
    r.store.db.prepare('UPDATE tickets SET agent_state = ? WHERE id = ?').run(state, r.id);
  };

  it.each(['running', 'waiting'])('starts no round and writes a debug line when the agent is %s and no window is named', async (state) => {
    const r = rig();
    setAgent(r, state);
    await sweepOnce(r);
    expect(sendCiFailureAction).not.toHaveBeenCalled();
    expect(r.debug).toHaveBeenCalledWith(`[ship] autopilot ticket ${r.id}: no round, the window that holds the session is not known`);
  });

  it('starts no round when the store names another window as the holder', async () => {
    const r = rig();
    setAgent(r, 'running');
    syncAutopilotSessionOwner(r.store, 'OTHER', [r.id]);
    await sweepOnce(r);
    expect(sendCiFailureAction).not.toHaveBeenCalled();
    expect(r.debug).toHaveBeenCalledWith(`[ship] autopilot ticket ${r.id}: no round, window OTHER holds the session (a closed window leaves its row until a window syncs)`);
  });

  it('starts no round beside another window even when agent_state shows idle', async () => {
    const r = rig();
    setAgent(r, 'idle');
    syncAutopilotSessionOwner(r.store, 'OTHER', [r.id]);
    await sweepOnce(r);
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });

  it('starts a round when no window holds a session (idle, no owner)', async () => {
    const r = rig();
    setAgent(r, 'idle');
    await sweepOnce(r);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
  });

  it('starts a round when this window is the stored owner and the agent is idle', async () => {
    const r = rig({ isLive: () => true });
    setAgent(r, 'idle');
    syncAutopilotSessionOwner(r.store, 'W', [r.id]);
    await sweepOnce(r);
    expect(sendCiFailureAction).toHaveBeenCalledTimes(1);
  });

  it('starts no round when this window holds a live session whose agent is running', async () => {
    const r = rig({ isLive: () => true });
    setAgent(r, 'running');
    await sweepOnce(r);
    expect(sendCiFailureAction).not.toHaveBeenCalled();
  });
});

describe('makeLaunchTracker', () => {
  it('hands out a launch once, and turns a rejected launch into a failed outcome', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: 'launched' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce('plain');
    const t = makeLaunchTracker(execute);
    expect(t.take(1)).toBeUndefined();
    t.open(1, 'p', 'r');
    expect(execute).toHaveBeenCalledWith(1, { seedPrompt: 'p', seedRepo: 'r' });
    expect(await t.take(1)).toEqual({ kind: 'launched' });
    expect(t.take(1)).toBeUndefined();
    t.open(2, 'p', 'r');
    expect(await t.take(2)).toEqual({ kind: 'failed', reason: 'boom' });
    t.open(3, 'p', 'r');
    expect(await t.take(3)).toEqual({ kind: 'failed', reason: 'plain' });
  });
});

describe('registerAutopilotCommands', () => {
  it('registers the three commands', () => {
    const names: string[] = [];
    const host = {
      commands: { registerCommand: (c: string) => { names.push(c); return { dispose() {} }; } },
      window: { showInformationMessage: vi.fn(), showQuickPick: vi.fn() },
    };
    const out = registerAutopilotCommands(host as never, { store: openStore(':memory:'), projectId: () => undefined, debug: () => {}, stopSession: async () => true });
    expect(host.window.showInformationMessage).not.toHaveBeenCalled();
    expect(names).toEqual(['karst.autopilot.setOverride', 'karst.autopilot.approveOne', 'karst.autopilot.stop']);
    expect(out).toHaveLength(3);
  });

  it('logs a command message with the ship prefix and maps the pickers', async () => {
    const handlers = new Map<string, (...a: never[]) => unknown>();
    const showQuickPick = vi.fn(async (items: readonly unknown[]) => items[0]);
    const host = {
      commands: { registerCommand: (c: string, h: (...a: never[]) => unknown) => { handlers.set(c, h); return { dispose() {} }; } },
      window: { showQuickPick },
    };
    const store = openStore(':memory:');
    const project = upsertProject(store, { slug: 'p' });
    const id = createTicket(store, { key: 'AP-8', title: 't', projectId: project.id }).id;
    const debug = vi.fn();
    registerAutopilotCommands(host as never, { store, projectId: () => project.id, debug, stopSession: async () => true });
    await (handlers.get('karst.autopilot.setOverride') as () => Promise<unknown>)();
    const calls = showQuickPick.mock.calls as unknown as Array<[unknown[], { placeHolder: string }]>;
    expect(calls[0]![1].placeHolder).toBe('Set auto-fix mode for which ticket?');
    expect(calls[1]![1].placeHolder).toBe('Auto-fix mode');
    expect(getAutopilotTicket(store, id).mode).toBe(calls[1]![0][0]);
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[ship\] autopilot command: /));
  });
});

describe('window helpers', () => {
  it('stableWindowId keeps a stored id and stores a new one', () => {
    const data = new Map<string, unknown>();
    const state = { get: <T,>(k: string) => data.get(k) as T | undefined, update: async (k: string, v: unknown) => { data.set(k, v); } };
    expect(stableWindowId(state, () => 'new')).toBe('new');
    expect(data.get('karst.windowId')).toBe('new');
    expect(stableWindowId(state, () => 'other')).toBe('new');
  });

  it('makeSessionOwnerSync writes the owner, and logs a store error instead of throwing', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'W-1', title: 't' }).id;
    const logError = vi.fn();
    makeSessionOwnerSync(store, 'W', logError)([id]);
    expect(getAutopilotSessionOwner(store, id)).toBe('W');
    expect(logError).not.toHaveBeenCalled();
    store.db.close();
    makeSessionOwnerSync(store, 'W', logError)([id]);
    expect(logError).toHaveBeenCalledWith('karst: session owner sync failed', expect.anything());
  });

  it('makeHostTicketCheck is true only for a recorded host placement', async () => {
    expect(await makeHostTicketCheck(() => ({ backend: 'host' }))(1)).toBe(true);
    expect(await makeHostTicketCheck(() => ({ backend: 'docker' }))(1)).toBe(false);
    expect(await makeHostTicketCheck(() => ({ backend: 'sbx' }))(1)).toBe(false);
    expect(await makeHostTicketCheck(() => null)(1)).toBe(false);
  });

  it('makeStopSession ends a held session, and reports a session this window does not hold', async () => {
    const stop = vi.fn(async () => {});
    const debug = vi.fn();
    expect(await makeStopSession({ isLive: () => true, stop, debug })(7)).toBe(true);
    expect(stop).toHaveBeenCalledWith(7);
    stop.mockClear();
    expect(await makeStopSession({ isLive: () => false, stop, debug })(7)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('[ship] autopilot ticket 7: stop now did not reach a session (this window does not hold it)');
  });
});
