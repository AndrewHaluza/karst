import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setAgentState, setStageCurrent } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { currentConflictDelivery, currentFixDelivery, getFixDelivery } from '../../store/fixDeliveries.js';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { fixPointer, messagePointer } from '../../workflow/messageDelivery.js';
import { isThenable } from './fixDeliveryOps.js';
import { makeFixDeliveryWiring, type FixDeliveryWiringDeps } from './fixDeliveryWiring.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };
const CH = { kind: 'sandbox' as const, runDir: '/karst-bridge/7', core: 'opencode2' };
const OLD = '2000-01-01T00:00:00.000Z';
type MirrorResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The D556 remote-mirror branches of the fix-delivery wiring: exact debug text and the pointer gate. */
describe('fixDeliveryWiring remote mirror (D556)', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  let root: string;
  const nudge = vi.fn<FixDeliveryWiringDeps['nudge']>(() => true);
  const debug = vi.fn<(m: string) => void>();
  const st = { live: true, agy: false };

  const make = (over: Partial<FixDeliveryWiringDeps> = {}) =>
    makeFixDeliveryWiring({
      store,
      projectId: () => projectId,
      isLive: () => st.live,
      isGraphTicket: () => false,
      sessionProvider: () => 'claude',
      currentLaunchId: () => 'L1',
      nudge,
      sessionChannel: () => CH,
      storageDir: root,
      literal: () => LITERAL,
      agyBusy: () => st.agy,
      debug,
      ...over,
    });
  const sandboxed = (over: Partial<FixDeliveryWiringDeps> = {}) => {
    const paths = bridgePaths(root, 7);
    mkdirSync(paths.dir, { recursive: true });
    return make({ bridgePaths: () => paths, ...over });
  };
  const lines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    store = openStore(':memory:');
    root = mkdtempSync(join(tmpdir(), 'karst-fixmirror-'));
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicket(store, { key: 'K-1', title: 't', projectId }).id;
    setStageCurrent(store, ticketId, 'fix');
    nudge.mockClear();
    nudge.mockReturnValue(true);
    debug.mockClear();
    Object.assign(st, { live: true, agy: false });
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('an ok:false mirror logs its exact reason and skips the attachment/log mirror', async () => {
    const mirrorDirs = vi.fn(async (): Promise<MirrorResult> => ({ ok: true }));
    const w = sandboxed({ mirror: async () => ({ ok: false, reason: 'not confirmed' }), mirrorDirs });
    await expect(w.deliver(ticketId, null)).resolves.toBe(false);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(lines()).toContain(`[driver] fix delivery #${id}: remote mirror refused (not confirmed)`);
    expect(mirrorDirs).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a rejected mirror logs its exact error', async () => {
    const w = sandboxed({ mirror: () => Promise.reject(new Error('ssh down')) });
    await expect(w.deliver(ticketId, null)).resolves.toBe(false);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(lines()).toContain(`[driver] fix delivery #${id}: remote mirror failed (ssh down)`);
  });

  it('an ok:false attachment/log mirror refuses the delivery with its exact reason', async () => {
    const w = sandboxed({ mirror: async () => ({ ok: true }), mirrorDirs: () => ({ ok: false, reason: 'scp refused' }) });
    await expect(w.deliver(ticketId, null)).resolves.toBe(false);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(lines()).toContain(`[driver] fix delivery #${id}: remote attachment/log mirror refused (scp refused)`);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a rejected attachment/log mirror refuses the delivery with its exact error', async () => {
    setAgentState(store, ticketId, 'idle');
    const w = sandboxed({ mirror: async () => ({ ok: true }), mirrorDirs: () => Promise.reject(new Error('tar failed')) });
    await expect(w.deliver(ticketId, null)).resolves.toBe(false);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(lines()).toContain(`[driver] fix delivery #${id}: remote attachment/log mirror failed (tar failed)`);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a mirrored brief and its dirs let the pointer through', async () => {
    const mirrorDirs = vi.fn(async (): Promise<MirrorResult> => ({ ok: true }));
    const w = sandboxed({ mirror: async () => ({ ok: true }), mirrorDirs });
    await expect(w.deliver(ticketId, null)).resolves.toBe(true);
    expect(mirrorDirs).toHaveBeenCalledWith(ticketId);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('a session that is not live: the typed pointer is unavailable and the row superseded', () => {
    st.live = false;
    const w = sandboxed();
    expect(w.deliver(ticketId, null)).toBe(false);
    expect(currentFixDelivery(store, ticketId)).toBeNull();
  });

  it('an idle host push session with a busy agy holds the immediate pointer', () => {
    st.agy = true;
    setAgentState(store, ticketId, 'idle');
    const w = make({ sessionChannel: () => 'cli-env' });
    expect(w.deliver(ticketId, null)).toBe(true);
    const id = currentFixDelivery(store, ticketId)!.id;
    expect(lines()).toContain(`[driver] fix delivery #${id}: idle push session for ticket ${ticketId}, immediate pointer held`);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('roundOf names a conflict row, and fix for a missing row; the typed line words the conflict', () => {
    const w = sandboxed();
    expect(w.deliverConflict(ticketId, 'api', 'C')).toBe(true);
    const conflict = currentConflictDelivery(store, ticketId, 'api')!;
    expect(w.roundOf(conflict.id)).toBe('conflict');
    expect(w.roundOf(999_999)).toBe('fix');
    expect(nudge.mock.calls[0]![1]).toBe(messagePointer(fixPointer(conflict.id, 'fix', 'conflict'), CH));
  });

  describe('pointAtLaunch through the brief write', () => {
    const seeded = async (w: ReturnType<typeof make>): Promise<void> => {
      await w.recordSeed(ticketId, null as never, 'LS');
      nudge.mockClear();
    };

    it('a mirrored seed brief: the pointer is sent after the mirror resolves', async () => {
      const w = sandboxed({ mirror: async () => ({ ok: true }) });
      await seeded(w);
      await expect(w.pointAtLaunch(ticketId, 'LS')).resolves.toBe('sent');
      expect(nudge).toHaveBeenCalledTimes(1);
    });

    it('a refused mirror: no pointer is typed', async () => {
      let ok = true;
      const w = sandboxed({ mirror: async () => (ok ? { ok: true } : { ok: false, reason: 'gone' }) });
      await seeded(w);
      ok = false;
      await expect(w.pointAtLaunch(ticketId, 'LS')).resolves.toBe('unsendable');
      expect(nudge).not.toHaveBeenCalled();
    });

    it('a sync refused write (no bridge dir): no pointer is typed', () => {
      const w = make();
      w.recordSeed(ticketId, null as never, 'LS');
      expect(w.pointAtLaunch(ticketId, 'LS')).toBe('unsendable');
      expect(nudge).not.toHaveBeenCalled();
    });
  });

  it('recordSeed returns a promise only while the remote mirror is pending', async () => {
    const asyncSeed = sandboxed({ mirror: async () => ({ ok: true }) }).recordSeed(ticketId, null as never, 'LA');
    expect(isThenable(asyncSeed)).toBe(true);
    await asyncSeed;
    expect(sandboxed().recordSeed(ticketId, null as never, 'LB')).toBeUndefined();
  });

  it('a stuck sandbox with no bridge dir names no inbox file and the sweep stays quiet', () => {
    st.agy = true;
    const w = make();
    expect(w.deliver(ticketId, null)).toBe(true);
    const id = currentFixDelivery(store, ticketId)!.id;
    store.db.prepare('UPDATE fix_deliveries SET created_at = ? WHERE id = ?').run(OLD, id);
    debug.mockClear();
    w.sweep.sweep();
    expect(getFixDelivery(store, id)!.pointerFailedAt).toBeNull();
    expect(lines().filter((l) => l.includes('sweep failed') || l.includes('unsendable'))).toEqual([]);
  });

  it('a stuck sandbox with a bridge dir names its inbox file once the window passes', () => {
    st.agy = true;
    const w = sandboxed();
    expect(w.deliver(ticketId, null)).toBe(true);
    const id = currentFixDelivery(store, ticketId)!.id;
    store.db.prepare('UPDATE fix_deliveries SET created_at = ? WHERE id = ?').run(OLD, id);
    w.sweep.sweep();
    expect(getFixDelivery(store, id)!.pointerFailedAt).not.toBeNull();
  });
});
