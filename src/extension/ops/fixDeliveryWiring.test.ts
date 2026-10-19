import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, setAgentState, setStageCurrent, updateTicketFields } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { setStage } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { openRecoveryRound } from '../../store/recoveryRoundsWrite.js';
import { currentFixDelivery, claimRead, getFixDelivery } from '../../store/fixDeliveries.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { ackFixDeliveryRef } from './fixDeliveryOps.js';
import { composeFixSnapshot, makeFixDeliveryWiring, type FixDeliveryWiringDeps } from './fixDeliveryWiring.js';

const LITERAL = { cli: '/ext/dist/cli.js', db: '/g/karst.db', manifest: '/w/karst.yml' };

describe('fixDeliveryWiring', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;
  const nudge = vi.fn<FixDeliveryWiringDeps['nudge']>(() => true);
  const state = { channel: 'cli-env' as 'mcp' | 'cli-env', agy: false, live: true, provider: 'claude' as string | null, literal: LITERAL as FixDeliveryWiringDeps['literal'] extends () => infer T ? T : never };

  const make = (over: Partial<FixDeliveryWiringDeps> = {}) =>
    makeFixDeliveryWiring({
      store,
      projectId: () => projectId,
      isLive: () => state.live,
      isGraphTicket: () => false,
      sessionProvider: () => state.provider,
      currentLaunchId: () => 'L1',
      nudge,
      sessionChannel: () => state.channel,
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
    state.channel = 'cli-env';
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
        `karst: fix brief #${id} ready - run node "$KARST_CLI" fix-brief --ack --db "$KARST_DB" --ticket "$KARST_TICKET_ID"`,
      );
    });

    it('typed route, MCP session: names the fix-brief tool, no paths', () => {
      state.provider = 'opencode2';
      state.channel = 'mcp';
      expect(make().deliver(ticketId, null)).toBe(true);
      const id = currentFixDelivery(store, ticketId)!.id;
      expect(nudge.mock.calls[0]![1]).toBe(`karst: fix brief #${id} ready - call the karst MCP tool "fix-brief" with ack: true`);
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

  describe('sandboxed session (inbox file + ack line, arch:AC-34)', () => {
    const CH = { kind: 'sandbox' as const, runDir: '/karst-bridge/7', core: 'opencode2' };
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'karst-fixsbx-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    const sandboxed = (over: Partial<FixDeliveryWiringDeps> = {}) => {
      const paths = bridgePaths(root, 7);
      mkdirSync(paths.dir, { recursive: true });
      return { paths, w: make({ sessionChannel: () => CH, bridgePaths: () => paths, ...over }) };
    };

    it('the snapshot carries the emit-marker fix command and no host CLI text', () => {
      const { body, footer } = composeFixSnapshot(store, ticketId, LITERAL, CH);
      expect(body).toContain('node /karst-bridge/7/opencode2/emit-marker.cjs /karst-bridge/7/events.ndjson fix');
      expect(body).not.toMatch(/KARST_|--db|stage fix pass|\/ext\/dist/);
      expect(footer).toBe('… truncated');
    });

    it('routes typed even for a push-capable core, writes the brief file, types an inbox pointer; the ack line marks it read', () => {
      const { paths, w } = sandboxed();
      expect(w.deliver(ticketId, null)).toBe(true);
      const row = currentFixDelivery(store, ticketId)!;
      expect(nudge).toHaveBeenCalledTimes(1);
      const line = nudge.mock.calls[0]![1];
      expect(line).toBe(`karst: fix brief #${row.id} ready - read /karst-bridge/7/inbox/fix-${row.id}.md, then run node /karst-bridge/7/opencode2/emit-ack.cjs /karst-bridge/7/events.ndjson fix-${row.id}`);
      expect(line).not.toMatch(/KARST_|--db|MCP/);
      expect(readFileSync(join(paths.inboxDir, `fix-${row.id}.md`), 'utf8')).toBe(row.body);
      nudge.mock.calls[0]![2]!.onTyped?.();
      expect(ackFixDeliveryRef(store, ticketId, `fix-${row.id}`, '2026-10-19T10:00:00Z')).toBe(true);
      expect(getFixDelivery(store, row.id)!.readAt).not.toBeNull();
    });

    it('a foreign ticket or bad ref ack leaves the delivery unread', () => {
      const { w } = sandboxed();
      w.deliver(ticketId, null);
      const row = currentFixDelivery(store, ticketId)!;
      expect(ackFixDeliveryRef(store, ticketId + 1, `fix-${row.id}`, 'x')).toBe(false);
      expect(ackFixDeliveryRef(store, ticketId, 'fix-../1', 'x')).toBe(false);
      expect(getFixDelivery(store, row.id)!.readAt).toBeNull();
    });

    it('a symlinked inbox/ is rejected: nothing typed or written outside, the sweep can retry', () => {
      const { paths, w } = sandboxed();
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, paths.inboxDir);
      w.deliver(ticketId, null);
      expect(nudge).not.toHaveBeenCalled();
      expect(readdirSync(outside)).toEqual([]);
    });

    it('no bridge dir known: unavailable, nothing typed', () => {
      const w = make({ sessionChannel: () => CH });
      w.deliver(ticketId, null);
      expect(nudge).not.toHaveBeenCalled();
    });
  });
});
