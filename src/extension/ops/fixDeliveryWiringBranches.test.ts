import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setAgentState, setStageCurrent } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { openRecoveryRound } from '../../store/recoveryRoundsWrite.js';
import { currentFixDelivery, getFixDelivery } from '../../store/fixDeliveries.js';
import { recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { composeFixSnapshot, makeFixDeliveryWiring, type FixDeliveryWiringDeps } from './fixDeliveryWiring.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };
const CH = { kind: 'sandbox' as const, runDir: '/karst-bridge/7', core: 'opencode2' };
const OLD = '2000-01-01T00:00:00.000Z';

describe('fixDeliveryWiring branches', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  let root: string;
  const nudge = vi.fn<FixDeliveryWiringDeps['nudge']>(() => true);
  const debug = vi.fn();
  const st = { live: true, agy: false, channel: 'cli-env' as 'cli-env' | 'mcp' | typeof CH };

  const make = (over: Partial<FixDeliveryWiringDeps> = {}) =>
    makeFixDeliveryWiring({
      store,
      projectId: () => projectId,
      isLive: () => st.live,
      isGraphTicket: () => false,
      sessionProvider: () => 'claude',
      currentLaunchId: () => 'L1',
      nudge,
      sessionChannel: () => st.channel,
      storageDir: root,
      literal: () => LITERAL,
      agyBusy: () => st.agy,
      debug,
      ...over,
    });
  const needsYou = (): string[] => debug.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('needs you'));
  const age = (id: number): void => {
    store.db.prepare('UPDATE fix_deliveries SET created_at = ? WHERE id = ?').run(OLD, id);
  };
  const pendingFixIntent = (launchId: string): void => {
    const roundId = openRecoveryRound(store, {
      ticketId, sourceStage: 'uat', sourceProcessId: 'gates', sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'gate-failure', triggerDetail: 'x', maxRounds: 3, startedAt: '2026-01-01T00:00:00Z',
    }).id;
    recordSessionLaunchIntent(store, {
      ticketId, launchId, purpose: 'fix', provider: 'claude', reason: 'fix', sessionOrigin: 'new',
      recoveryRoundId: roundId, at: '2026-01-01T00:00:00Z',
    } as never);
  };

  beforeEach(() => {
    store = openStore(':memory:');
    root = mkdtempSync(join(tmpdir(), 'karst-fixbr-'));
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicket(store, { key: 'K-1', title: 't', projectId }).id;
    setStageCurrent(store, ticketId, 'fix');
    nudge.mockClear();
    nudge.mockReturnValue(true);
    debug.mockClear();
    Object.assign(st, { live: true, agy: false, channel: 'cli-env' });
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('the marker and footer name the ticket key, not its id', () => {
    const snap = composeFixSnapshot(store, ticketId, LITERAL);
    expect(snap.footer.endsWith('--ticket K-1')).toBe(true);
    expect(snap.body).toContain('K-1');
  });

  describe('host pointer that cannot be sent', () => {
    const stuck = (over: Partial<FixDeliveryWiringDeps> = {}, liveAfter = true) => {
      const w = make(over);
      setAgentState(store, ticketId, 'idle');
      w.deliver(ticketId, null);
      const row = currentFixDelivery(store, ticketId)!;
      age(row.id);
      st.live = liveAfter;
      return { w, row };
    };

    it('names a missing live session in the reason, for an MCP session too', () => {
      st.channel = 'mcp';
      const { w, row } = stuck({}, false);
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).not.toBeNull();
      expect(needsYou()).toHaveLength(1);
      expect(needsYou()[0]).toContain('(no live agent session in this window)');
      expect(debug.mock.calls.map((c) => String(c[0]))).toContain(
        `[driver] fix delivery #${row.id}: host pointer unsendable — no live agent session in this window`,
      );
      expect(getTicket(store, ticketId).agentState).toBe('not-started');
    });

    it('names a still-starting fix launch in the reason', () => {
      const { w, row } = stuck();
      pendingFixIntent('L1');
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).not.toBeNull();
      expect(needsYou()[0]).toContain('(the fix launch is still starting)');
    });

    it('a live host with no pending launch is not escalated', () => {
      const { w, row } = stuck();
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
      expect(needsYou()).toEqual([]);
    });

    it('a pending intent for another launch does not escalate', () => {
      const { w, row } = stuck();
      pendingFixIntent('OTHER');
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
    });

    it('a window that does not own the ticket never escalates a still-starting launch', () => {
      const { w, row } = stuck({ owns: () => false });
      pendingFixIntent('L1');
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
    });
  });

  describe('sandbox pointer that cannot be sent', () => {
    const sandboxed = (over: Partial<FixDeliveryWiringDeps> = {}) => {
      st.channel = CH;
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      const w = make({ bridgePaths: () => paths, ...over });
      return { paths, w };
    };
    const stuck = (over: Partial<FixDeliveryWiringDeps> = {}, liveAfter = true) => {
      const { paths, w } = sandboxed(over);
      w.deliver(ticketId, null);
      const row = currentFixDelivery(store, ticketId)!;
      age(row.id);
      nudge.mockClear();
      st.live = liveAfter;
      return { paths, w, row };
    };

    it('a live, idle session with no pending launch is not stuck', () => {
      const { w, row } = stuck();
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
      expect(needsYou()).toEqual([]);
    });

    it('a window that does not own the ticket never escalates', () => {
      const { w, row } = stuck({ owns: () => false }, false);
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
    });

    it('stuck but the inbox write is refused: nothing to point at, no escalation', () => {
      const { row } = stuck({}, false);
      const w = make({ bridgePaths: () => undefined });
      w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).toBeNull();
    });
  });

  describe('sandbox inbox brief', () => {
    it('recordSeed writes the inbox file for a sandboxed launch, and none for a host launch', () => {
      st.channel = CH;
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      const w = make({ bridgePaths: () => paths });
      w.recordSeed(ticketId, null as never, 'LS');
      const row = currentFixDelivery(store, ticketId)!;
      expect(readFileSync(join(paths.inboxDir, `fix-${row.id}.md`), 'utf8')).toBe(row.body);
    });

    it('recordSeed of a host launch writes no inbox file', () => {
      const w = make({ bridgePaths: () => { throw new Error('must not be asked'); } });
      expect(() => w.recordSeed(ticketId, null as never, 'LS')).not.toThrow();
    });

    it('rewrites a host gate-log path to its sandbox copy', () => {
      st.channel = CH;
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      const logDir = join(root, 'artifacts', String(ticketId));
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'gate.log'), 'log text');
      const w = make({ bridgePaths: () => paths });
      w.recordSeed(ticketId, null as never, 'LS');
      const row = currentFixDelivery(store, ticketId)!;
      store.db.prepare('UPDATE fix_deliveries SET body = ? WHERE id = ?').run(`see ${join(logDir, 'gate.log')}`, row.id);
      expect(w.pointAtLaunch(ticketId, 'LS')).toBe('sent');
      expect(readFileSync(join(paths.inboxDir, `fix-${row.id}.md`), 'utf8')).toBe('see /karst-bridge/7/logs/gate.log');
    });

    it('a delivery that is gone writes nothing and the pointer is unavailable', () => {
      st.channel = CH;
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      const w = make({ bridgePaths: () => paths });
      w.deliver(ticketId, null);
      const row = currentFixDelivery(store, ticketId)!;
      store.db.prepare("UPDATE fix_deliveries SET launch_id = 'LG' WHERE id = ?").run(row.id);
      store.db.prepare('DELETE FROM fix_deliveries WHERE id = ?').run(row.id);
      nudge.mockClear();
      expect(w.pointAtLaunch(ticketId, 'LG')).toBe('no-row');
      expect(nudge).not.toHaveBeenCalled();
    });

    it('a sandbox with no bridge dir types nothing and leaves the row for the sweep', () => {
      st.channel = CH;
      const w = make();
      expect(w.deliver(ticketId, null)).toBe(true);
      expect(nudge).not.toHaveBeenCalled();
    });
  });

  describe('ssh remote mirror (D556)', () => {
    const sandboxed = (mirror: FixDeliveryWiringDeps['mirror']) => {
      st.channel = CH;
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      return { paths, w: make({ bridgePaths: () => paths, ...(mirror ? { mirror } : {}) }) };
    };

    it('types the pointer only AFTER the mirror resolves', async () => {
      let release!: (r: { ok: true }) => void;
      const mirror = vi.fn(() => new Promise<{ ok: true }>((resolve) => { release = resolve; }));
      const { w } = sandboxed(mirror);
      const pending = w.deliver(ticketId, null);
      expect(mirror).toHaveBeenCalledWith(ticketId, expect.stringMatching(/^inbox\/fix-[0-9]+\.md$/), expect.any(String));
      expect(nudge).not.toHaveBeenCalled();
      release({ ok: true });
      await pending;
      expect(nudge).toHaveBeenCalledTimes(1);
    });

    it('an ok:false mirror blocks the nudge and leaves the row for the sweep', async () => {
      const mirror = vi.fn(async () => ({ ok: false as const, reason: 'ssh remote devbox not confirmed' }));
      const { w } = sandboxed(mirror);
      await expect(w.deliver(ticketId, null)).resolves.toBe(false);
      expect(nudge).not.toHaveBeenCalled();
      expect(currentFixDelivery(store, ticketId)!.supersededAt).toBeNull();
    });

    it('a rejected mirror blocks the nudge like a false write', async () => {
      const mirror = vi.fn(() => Promise.reject(new Error('ssh down')));
      const { w } = sandboxed(mirror);
      await expect(w.deliver(ticketId, null)).resolves.toBe(false);
      expect(nudge).not.toHaveBeenCalled();
    });

    it('a failing mirror leaves the row for the sweep, which escalates as Needs you', async () => {
      const mirror = vi.fn(async () => ({ ok: false as const, reason: 'ssh remote devbox not confirmed' }));
      const { w } = sandboxed(mirror);
      await w.recordSeed(ticketId, null as never, 'LS');
      const row = currentFixDelivery(store, ticketId)!;
      age(row.id);
      st.live = false;
      await w.sweep.sweep();
      expect(getFixDelivery(store, row.id)!.pointerFailedAt).not.toBeNull();
      expect(needsYou().some((m) => m.includes('the fix pointer could not be sent'))).toBe(true);
    });
  });

  describe('hook channel', () => {
    it('armed is true only for a current, armed, unpointed, unread row', () => {
      st.channel = 'cli-env';
      const w = make({ sessionProvider: () => 'claude' });
      expect(w.armed(ticketId)).toBe(false);
      w.deliver(ticketId, null);
      const id = currentFixDelivery(store, ticketId)!.id;
      expect(w.armed(ticketId)).toBe(true);
      for (const col of ['pointed_at', 'read_at', 'pointer_failed_at']) {
        store.db.prepare(`UPDATE fix_deliveries SET ${col} = 'x' WHERE id = ?`).run(id);
        expect(w.armed(ticketId)).toBe(false);
        store.db.prepare(`UPDATE fix_deliveries SET ${col} = NULL WHERE id = ?`).run(id);
      }
      expect(w.armed(ticketId)).toBe(true);
      store.db.prepare('UPDATE fix_deliveries SET armed_at = NULL WHERE id = ?').run(id);
      expect(w.armed(ticketId)).toBe(false);
    });

    it('eligible is null without a row and the row id with one', () => {
      const w = make({ sessionProvider: () => 'claude' });
      expect(w.eligible(ticketId)).toBeNull();
      w.deliver(ticketId, null);
      expect(w.eligible(ticketId)).toBe(currentFixDelivery(store, ticketId)!.id);
    });

    it('claimPointed claims the given delivery only', () => {
      const w = make({ sessionProvider: () => 'claude' });
      w.deliver(ticketId, null);
      const id = currentFixDelivery(store, ticketId)!.id;
      expect(w.claimPointed(ticketId, id + 100)).toBe(false);
      expect(getFixDelivery(store, id)!.pointedAt).toBeNull();
      expect(w.claimPointed(ticketId, id)).toBe(true);
      expect(getFixDelivery(store, id)!.pointedAt).not.toBeNull();
    });
  });
});
