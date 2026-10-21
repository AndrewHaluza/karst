import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/dispatch.js')>();
  return { ...actual, dispatchHook: vi.fn(() => ({ admitted: true })) };
});
import { dispatchHook, type HookPayload } from '../../hooks/dispatch.js';
import type { HookChannelRecorder } from '../../diagnostics/hookChannel.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setSessionId } from '../../store/tickets.js';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import type { BridgeAttachment, BridgeAttachmentDeps } from '../../agent/bridge/bridgeSink.js';
import { getFixDelivery, upsertFixDelivery } from '../../store/fixDeliveries.js';
import { BRIDGE_POLL_INTERVAL_MS, makeBridgeBuild, openBridgeTicketIds, type BridgeBuildDeps } from './bridgeWiring.js';

const dispatchMock = vi.mocked(dispatchHook);
let store: Store;
let ticketId: number;
let captured: BridgeAttachmentDeps[];
const attachment: BridgeAttachment = { start: vi.fn(), stop: vi.fn(async () => {}), pollOnce: vi.fn(async () => {}), retryPending: vi.fn(async () => {}) };
const paths = bridgePaths('/g', 1);

const addWorktree = (id: number, path: string): void => {
  store.db.prepare("INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, 'api', ?, 'b')").run(id, path);
};

function deps(over: Partial<BridgeBuildDeps> = {}): BridgeBuildDeps {
  return {
    store,
    hookDispatch: {},
    launchIdFor: () => 'L1',
    cli: () => ({ cliEntry: '/ext/cli.js', dbPath: '/g/karst.db', manifestPath: '/r/karst.yml' }),
    nodePath: '/bin/node',
    attach: (d) => {
      captured.push(d);
      return attachment;
    },
    ...over,
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
  addWorktree(ticketId, '/wt/t1');
  captured = [];
  dispatchMock.mockClear();
});

describe('makeBridgeBuild', () => {
  it('builds an attachment with live expectations from the store', () => {
    let launch: string | undefined = 'L1';
    const build = makeBridgeBuild(deps({ launchIdFor: (id) => (id === ticketId ? launch : 'other') }));
    expect(build(ticketId, paths)).toBe(attachment);
    const d = captured[0]!;
    expect(d.paths).toBe(paths);
    expect(d.intervalMs).toBe(BRIDGE_POLL_INTERVAL_MS);
    expect(BRIDGE_POLL_INTERVAL_MS).toBe(250);
    expect(d.expect.ticketId).toBe(ticketId);
    expect(d.expect.worktreePath).toBe('/wt/t1');
    expect(d.expect.launchId).toBe('L1');
    launch = 'L2';
    expect(d.expect.launchId).toBe('L2');
    expect(d.expect.sessionId()).toBeUndefined();
    setSessionId(store, ticketId, 'sess-9', 'claude');
    expect(d.expect.sessionId()).toBe('sess-9');
    expect(d.expect.sessionLaunchId()).toBeUndefined();
    setSessionId(store, ticketId, 'sess-10', 'claude', 'L2');
    expect(d.expect.sessionLaunchId()).toBe('L2');
    expect(d.expect.stage()).toBe('scope');
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    expect(d.expect.stage()).toBe('impl');
  });

  it('stage() and sessionId() read nothing for a ticket deleted after attach', () => {
    const build = makeBridgeBuild(deps());
    build(ticketId, paths);
    store.db.prepare('DELETE FROM worktrees WHERE ticket_id = ?').run(ticketId);
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
    expect(captured[0]!.expect.stage()).toBeNull();
    expect(captured[0]!.expect.sessionId()).toBeUndefined();
  });

  it('dispatches through dispatchHook with the endpoint closures', () => {
    const closures = {
      notify: vi.fn(),
      shouldApplyState: vi.fn(() => true),
      sessionProviderFor: vi.fn(() => null),
      recorder: { record: vi.fn(), snapshot: vi.fn() } as unknown as HookChannelRecorder,
      debug: vi.fn(),
      tracker: undefined,
    };
    const build = makeBridgeBuild(deps({ hookDispatch: closures }));
    build(ticketId, paths);
    const payload: HookPayload = { hook_event_name: 'Stop', session_id: 's', cwd: '/wt/t1' };
    captured[0]!.dispatch(payload);
    expect(dispatchMock).toHaveBeenCalledWith(
      store, payload, closures.notify, closures.shouldApplyState, closures.sessionProviderFor,
      closures.recorder, closures.debug, undefined,
    );
  });

  it('a dispatch that throws is logged, never thrown into the poller', () => {
    dispatchMock.mockImplementationOnce(() => { throw new Error('db gone'); });
    const debug = vi.fn();
    makeBridgeBuild(deps({ debug }))(ticketId, paths);
    expect(() => captured[0]!.dispatch({ hook_event_name: 'Stop' })).not.toThrow();
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${ticketId} dispatch failed: db gone`);
    dispatchMock.mockImplementationOnce(() => { throw 'str'; });
    captured[0]!.dispatch({ hook_event_name: 'Stop' });
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${ticketId} dispatch failed: str`);
  });

  it('runs the marker CLI with the session facts, in the worktree', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    makeBridgeBuild(deps({ spawn }))(ticketId, paths);
    expect(await captured[0]!.runMarker('impl')).toEqual({ code: 0, stderr: '' });
    expect(spawn).toHaveBeenCalledWith(
      '/bin/node',
      ['/ext/cli.js', 'stage', 'impl', 'pass', '--db', '/g/karst.db', '--manifest', '/r/karst.yml', '--ticket', 'K-1'],
      '/wt/t1',
    );
  });

  it('falls back to the numeric id when the ticket has no key', async () => {
    store.db.prepare("UPDATE tickets SET key = '' WHERE id = ?").run(ticketId);
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    makeBridgeBuild(deps({ spawn }))(ticketId, paths);
    await captured[0]!.runMarker('impl');
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[1].at(-1)).toBe(String(ticketId));
  });

  it('syncs the sandbox before the CLI and carries a sync failure out as a transient marker failure (T700)', async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const ensureSynced = vi.fn(async () => ({ ok: false as const, reason: 'sbx down', diverged: false }));
    makeBridgeBuild(deps({ spawn, ensureSynced }))(ticketId, paths);
    expect(await captured[0]!.runMarker('impl')).toMatchObject({ code: 1, stderr: 'sbx down', transient: true });
    expect(ensureSynced).toHaveBeenCalledWith(ticketId);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a marker failure is a WARN plus a user notification; a diverged branch asks the user', () => {
    const warn = vi.fn();
    const notifyFailure = vi.fn();
    makeBridgeBuild(deps({ warn, notifyFailure }))(ticketId, paths);
    captured[0]!.onMarkerFailure!({ stage: 'impl', reason: 'no repository has changes', diverged: false });
    captured[0]!.onMarkerFailure!({ stage: 'impl', reason: 'not a fast-forward', diverged: true });
    captured[0]!.onMarkerFailure!({ stage: 'fix', reason: 'x (gave up after 8 retries)', diverged: false, gaveUp: true });
    expect(warn).toHaveBeenCalledWith('Karst: K-1 impl done marker failed: no repository has changes');
    expect(notifyFailure.mock.calls).toEqual([
      [ticketId, 'Karst: K-1 impl done marker failed: no repository has changes', false, false],
      [ticketId, 'Karst: K-1 impl done marker failed: not a fast-forward', true, false],
      [ticketId, 'Karst: K-1 fix done marker failed: x (gave up after 8 retries)', false, true],
    ]);
  });

  it('passes debug to the attachment', () => {
    const debug = vi.fn();
    makeBridgeBuild(deps({ debug }))(ticketId, paths);
    expect(captured[0]!.debug).toBe(debug);
  });

  it('returns undefined for an unknown ticket', () => {
    const debug = vi.fn();
    expect(makeBridgeBuild(deps({ debug }))(999, paths)).toBeUndefined();
    expect(captured).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith('[bridge] ticket 999 not attached: no such ticket');
  });

  it('returns undefined without a debug sink too', () => {
    expect(makeBridgeBuild(deps())(999, paths)).toBeUndefined();
  });

  it('returns undefined for a ticket with no worktree', () => {
    const bare = createTicket(store, { key: 'K-2', title: 'b' }).id;
    const debug = vi.fn();
    expect(makeBridgeBuild(deps({ debug }))(bare, paths)).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${bare} not attached: no worktree`);
  });

  it('returns undefined when the manifest is unresolved (the marker CLI needs it)', () => {
    const debug = vi.fn();
    const build = makeBridgeBuild(deps({ debug, cli: () => ({ cliEntry: '/c', dbPath: '/d', manifestPath: undefined }) }));
    expect(build(ticketId, paths)).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${ticketId} not attached: manifest unresolved`);
  });
});

describe('openBridgeTicketIds', () => {
  it('is every ticket not archived and not done', () => {
    const done = createTicket(store, { key: 'K-2', title: 'd' }).id;
    const archived = createTicket(store, { key: 'K-3', title: 'a' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done);
    store.db.prepare("UPDATE tickets SET archived_at = 'x' WHERE id = ?").run(archived);
    expect(openBridgeTicketIds(store)).toEqual(new Set([ticketId]));
  });
});

describe('makeBridgeBuild onAck (sandbox inbox ack, F10)', () => {
  it('marks this ticket\'s pending fix delivery read and logs it; a stale ref is ignored and logged', () => {
    const debug = vi.fn();
    makeBridgeBuild(deps({ debug }))(ticketId, paths);
    const row = upsertFixDelivery(store, { ticketId, recoveryRoundId: null, launchId: 'L1', body: 'B', truncatedFooter: 'F', at: '2026-10-19T10:00:00Z' });
    captured[0]!.onAck!(`fix-${row}`);
    expect(getFixDelivery(store, row)!.readAt).not.toBeNull();
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${ticketId} ack fix-${row}: delivery marked read`);
    captured[0]!.onAck!(`fix-${row}`);
    expect(debug).toHaveBeenCalledWith(`[bridge] ticket ${ticketId} ack fix-${row}: ignored (not a pending delivery of this ticket)`);
  });
});
