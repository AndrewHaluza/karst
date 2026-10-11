import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setAgentState, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { setStage } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { openRecoveryRound } from '../../store/recoveryRoundsWrite.js';
import { currentFixDelivery, claimRead, getFixDelivery } from '../../store/fixDeliveries.js';
import { composeFixSnapshot, makeFixDeliveryWiring, type FixDeliveryWiringDeps } from './fixDeliveryWiring.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

describe('fixDeliveryWiring', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  const nudge = vi.fn<FixDeliveryWiringDeps['nudge']>(() => true);
  const state = { agy: false, live: true, provider: 'claude' as string | null, literal: LITERAL as FixDeliveryWiringDeps['literal'] extends () => infer T ? T : never };

  const make = (over: Partial<FixDeliveryWiringDeps> = {}) =>
    makeFixDeliveryWiring({
      store,
      projectId: () => projectId,
      isLive: () => state.live,
      isGraphTicket: () => false,
      sessionProvider: () => state.provider,
      currentLaunchId: () => 'L1',
      nudge,
      sessionCliEnv: () => undefined,
      literal: () => state.literal,
      agyBusy: () => state.agy,
      debug: vi.fn(),
      ...over,
    });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicket(store, { key: 'K-1', title: 't', projectId }).id;
    updateTicketFields(store, ticketId, { description: 'desc' });
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed' });
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-01-01T00:00:00Z',
      gates: [{ gateName: 'lint', exitCode: 1, summary: 'error: unused import' }],
    });
    setStageCurrent(store, ticketId, 'fix');
    nudge.mockClear();
    state.agy = false;
    state.live = true;
    state.provider = 'claude';
    state.literal = LITERAL;
  });
  afterEach(() => store.close());

  describe('composeFixSnapshot', () => {
    it('carries the brief and a done marker built from literal tokens only', () => {
      const { body } = composeFixSnapshot(store, ticketId, LITERAL);
      expect(body).toContain('lint');
      expect(body).toContain('"/ext/dist/cli.js" stage fix pass');
      expect(body).not.toContain('$KARST_');
    });

    it('footer names the live brief command with literals', () => {
      expect(composeFixSnapshot(store, ticketId, LITERAL).footer).toBe(
        '… truncated; full live brief: node "/ext/dist/cli.js" fix-brief --db "/g/karst.db" --manifest "/w/karst.yml" --ticket K-1',
      );
    });
  });

  describe('deliver (live path)', () => {
    it('push route: arms the stored snapshot, types nothing', () => {
      const w = make();
      expect(w.deliver(ticketId, null)).toBe(true);
      const row = currentFixDelivery(store, ticketId)!;
      expect(row.armedAt).not.toBeNull();
      expect(row.body).toContain('stage fix pass');
      expect(nudge).not.toHaveBeenCalled();
      expect(w.eligible(ticketId)).toBe(row.id);
    });

    it('typed route: types ONE pointer line, never the brief', () => {
      state.provider = 'opencode2';
      expect(make().deliver(ticketId, null)).toBe(true);
      const id = currentFixDelivery(store, ticketId)!.id;
      expect(nudge).toHaveBeenCalledTimes(1);
      expect(nudge.mock.calls[0]![1]).toBe(
        `karst: fix brief #${id} ready - run node "/ext/dist/cli.js" fix-brief --ack --db "/g/karst.db" --manifest "/w/karst.yml" --ticket ${ticketId}`,
      );
    });

    it('typed route, running agent: nothing typed now', () => {
      state.provider = 'opencode2';
      setAgentState(store, ticketId, 'running');
      expect(make().deliver(ticketId, null)).toBe(true);
      expect(nudge).not.toHaveBeenCalled();
    });

    it('typed route, agy not idle: held, success', () => {
      state.provider = 'antigravity';
      state.agy = true;
      expect(make().deliver(ticketId, null)).toBe(true);
      expect(nudge).not.toHaveBeenCalled();
    });

    it('typed route, no terminal: fails and supersedes', () => {
      state.provider = 'opencode2';
      nudge.mockReturnValueOnce(false);
      expect(make().deliver(ticketId, null)).toBe(false);
      expect(currentFixDelivery(store, ticketId)).toBeNull();
    });

    it('typed route, unbuildable literal: needs-you once, no line typed', () => {
      state.provider = 'opencode2';
      state.literal = { ...LITERAL, db: '/g/$bad.db' };
      expect(make().deliver(ticketId, null)).toBe(true);
      expect(nudge).not.toHaveBeenCalled();
      expect(currentFixDelivery(store, ticketId)!.pointerFailedAt).not.toBeNull();
      expect(getFixDeliveryAgent()).toBe('not-started');
    });
  });

  function getFixDeliveryAgent(): string | null {
    return (store.db.prepare('SELECT agent_state AS s FROM tickets WHERE id = ?').get(ticketId) as { s: string | null }).s;
  }

  describe('seed path', () => {
    it('recordSeed stores a launch-bound snapshot', () => {
      const roundId = openRecoveryRound(store, {
        ticketId,
        sourceStage: 'uat',
        sourceProcessId: 'gates',
        sourceStageRunId: null,
        sourceProcessRunId: null,
        triggerKind: 'gate-failure',
        triggerDetail: 'lint failed',
        maxRounds: 3,
        startedAt: '2026-01-01T00:00:00Z',
      }).id;
      make().recordSeed(ticketId, roundId, 'LX');
      expect(currentFixDelivery(store, ticketId)).toMatchObject({ launchId: 'LX', recoveryRoundId: roundId });
    });

    it('supersedeUnread retires stale rows but not read ones', () => {
      const w = make();
      w.deliver(ticketId, null);
      const stale = currentFixDelivery(store, ticketId)!.id;
      w.supersedeUnread(ticketId);
      expect(getFixDelivery(store, stale)!.supersededAt).not.toBeNull();
      w.deliver(ticketId, null);
      const read = currentFixDelivery(store, ticketId)!.id;
      claimRead(store, read, 'seed', 'x');
      w.supersedeUnread(ticketId);
      expect(getFixDelivery(store, read)!.supersededAt).toBeNull();
    });
  });

  it('claimPointed is the conditional once-only claim', () => {
    const w = make();
    w.deliver(ticketId, null);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(w.claimPointed(ticketId, id)).toBe(true);
    expect(w.claimPointed(ticketId, id)).toBe(false);
  });

  describe('pointAtLaunch (delivery guard)', () => {
    it('no-row for a launch without a snapshot', () => {
      expect(make().pointAtLaunch(ticketId, 'nope')).toBe('no-row');
    });

    it('types the pointer for the launch-bound snapshot and claims pointed on typing', () => {
      const w = make();
      const roundId = openRecoveryRound(store, {
        ticketId, sourceStage: 'uat', sourceProcessId: 'gates', sourceStageRunId: null,
        sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 'x',
        maxRounds: 3, startedAt: '2026-01-01T00:00:00Z',
      }).id;
      w.recordSeed(ticketId, roundId, 'LS');
      const id = currentFixDelivery(store, ticketId)!.id;
      expect(w.pointAtLaunch(ticketId, 'LS')).toBe('sent');
      expect(nudge.mock.calls[0]![1]).toContain(`fix brief #${id} ready`);
      expect(getFixDelivery(store, id)!.pointedAt).toBeNull();
      nudge.mock.calls[0]![2].onTyped!();
      expect(getFixDelivery(store, id)!.pointedAt).not.toBeNull();
    });

    it('unsendable when no terminal takes the line', () => {
      const w = make();
      w.deliver(ticketId, null);
      store.db.prepare("UPDATE fix_deliveries SET launch_id = 'LZ'").run();
      nudge.mockReturnValueOnce(false);
      expect(w.pointAtLaunch(ticketId, 'LZ')).toBe('unsendable');
    });
  });

  describe('snapshot details', () => {
    it('falls back to a generic brief when no gate evidence exists', () => {
      const bare = createTicket(store, { key: 'K-9', title: 'bare', projectId }).id;
      const { body } = composeFixSnapshot(store, bare, LITERAL);
      expect(body).toContain('A gate failed for ticket');
      expect(body).toContain('Re-run the checks, fix what they report');
    });

    it('addresses the marker and footer by ticket key, else by id', () => {
      expect(composeFixSnapshot(store, ticketId, LITERAL).body).toContain('K-1');
      const keyless = createTicket(store, { key: '', title: 'k', projectId }).id;
      const snap = composeFixSnapshot(store, keyless, LITERAL);
      expect(snap.footer.endsWith(`--ticket ${keyless}`)).toBe(true);
      expect(snap.body).toContain(String(keyless));
    });

    it('a vanished terminal or graph-owned ticket cannot be pointed at', () => {
      state.provider = 'opencode2';
      state.live = false;
      const w = make();
      state.live = true;
      expect(w.deliver(ticketId, null)).toBe(true); // typed send reached nudge
      state.live = false;
      const row = currentFixDelivery(store, ticketId)!;
      store.db.prepare("UPDATE fix_deliveries SET launch_id = 'LZ' WHERE id = ?").run(row.id);
      expect(w.pointAtLaunch(ticketId, 'LZ')).toBe('unsendable');
      state.live = true;
      const g = make({ isGraphTicket: () => true });
      expect(g.pointAtLaunch(ticketId, 'LZ')).toBe('unsendable');
    });
  });
});
