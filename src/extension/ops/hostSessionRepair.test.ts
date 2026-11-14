import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket, getTicket, setAgentState, setSessionId } from '../../store/tickets.js';
import { recordPlacement } from '../../store/placement.js';
import { confirmSessionLaunchIntent, recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { repairHostSessions } from './hostSessionRepair.js';

describe('repairHostSessions (T1121)', () => {
  let store: Store;
  let ticketId: number;
  const info = vi.fn();
  beforeEach(() => {
    info.mockClear();
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicket(store, { key: 'K-1', title: 't', projectId }).id;
    recordPlacement(store, ticketId, { backend: 'host', core: 'claude', sandboxName: null, reason: null }, 'claude');
    setAgentState(store, ticketId, 'idle');
  });
  afterEach(() => store.close());

  const confirmed = (launchId: string, sessionId: string, at: string): void => {
    recordSessionLaunchIntent(store, { ticketId, launchId, purpose: 'implementation', provider: 'claude', model: null, reason: 'initial', sessionOrigin: 'new', at });
    expect(confirmSessionLaunchIntent(store, launchId, { ticketId, provider: 'claude', providerSessionId: sessionId, at })).toBe('confirmed');
  };
  const run = (ids = [ticketId]) => repairHostSessions({ store, live: () => ids, owns: () => true, info });

  it('restores session id, provider and launch id of a live host ticket from its latest confirmed launch', () => {
    confirmed('L1', 'S1', '2026-01-01T00:00:00.000Z');
    confirmed('L2', 'S2', '2026-01-01T01:00:00.000Z');
    setSessionId(store, ticketId, null, null);
    expect(run()).toEqual([ticketId]);
    const t = getTicket(store, ticketId);
    expect([t.sessionId, t.sessionProvider]).toEqual(['S2', 'claude']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`ticket ${ticketId}`));
  });
  it('leaves a ticket that still has a session id alone', () => {
    confirmed('L1', 'S1', '2026-01-01T00:00:00.000Z');
    setSessionId(store, ticketId, 'KEEP', 'claude');
    expect(run()).toEqual([]);
    expect(getTicket(store, ticketId).sessionId).toBe('KEEP');
  });
  it('leaves a sandbox ticket, a foreign-window ticket and a ticket with no live agent alone', () => {
    confirmed('L1', 'S1', '2026-01-01T00:00:00.000Z');
    setSessionId(store, ticketId, null, null);
    expect(repairHostSessions({ store, live: () => [ticketId], owns: () => false, info })).toEqual([]);
    setAgentState(store, ticketId, 'none');
    expect(run()).toEqual([]);
    setAgentState(store, ticketId, 'idle');
    recordPlacement(store, ticketId, { backend: 'sbx', core: 'claude', sandboxName: 'n', reason: null }, 'claude');
    expect(run()).toEqual([]);
    expect(getTicket(store, ticketId).sessionId).toBeNull();
  });
  it('does not restore a session whose recorded provider is unknown', () => {
    confirmed('L1', 'S1', '2026-01-01T00:00:00.000Z');
    store.db.prepare("UPDATE session_launch_intents SET provider = 'bogus' WHERE launch_id = 'L1'").run();
    setSessionId(store, ticketId, null, null);
    expect(run()).toEqual([]);
    expect(getTicket(store, ticketId).sessionId).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('unknown provider'));
  });
  it('does nothing when no launch was ever confirmed', () => {
    expect(run()).toEqual([]);
  });
  it('does nothing while a newer launch is still pending', () => {
    confirmed('L1', 'S1', '2026-01-01T00:00:00.000Z');
    recordSessionLaunchIntent(store, { ticketId, launchId: 'L2', purpose: 'implementation', provider: 'claude', model: null, reason: 'resume', sessionOrigin: 'resume', at: '2026-01-01T02:00:00.000Z' });
    setSessionId(store, ticketId, null, null);
    expect(run()).toEqual([]);
  });
});
