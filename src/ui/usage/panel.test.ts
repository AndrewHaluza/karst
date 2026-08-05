import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { recordTokenUsage } from '../../store/tokenUsage.js';
import { UsagePanelManager, type UsagePanel, type UsagePanelHost } from './panel.js';
import type { UsageHostMessage } from './messages.js';
import type { UsageState } from './state.js';
import { DEFAULT_USAGE_SORT } from '../../store/tokenUsageQuery.js';

let store: Store;

interface FakePanel extends UsagePanel {
  posted: UsageHostMessage[];
  revealed: number;
  emit(message: unknown): void;
  dispose(): void;
}

function fakeHost(): UsagePanelHost & { panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  return {
    panels,
    createPanel: (): UsagePanel => {
      const handlers: ((m: unknown) => void)[] = [];
      let disposeHandler: (() => void) | undefined;
      const panel: FakePanel = {
        posted: [],
        revealed: 0,
        reveal: () => {
          panel.revealed++;
        },
        postMessage: (m) => panel.posted.push(m),
        onDidReceiveMessage: (h) => handlers.push(h),
        onDidDispose: (h) => {
          disposeHandler = h;
        },
        emit: (m) => handlers.forEach((h) => h(m)),
        dispose: () => disposeHandler?.(),
      };
      panels.push(panel);
      return panel;
    },
  };
}

function seed(ticketId: number | null, tokens: number, at = '2026-07-30T00:00:00.000Z'): void {
  recordTokenUsage(store, {
    projectId: 1,
    ticketId,
    callSite: 'ticket-analysis',
    provider: 'claude',
    outcome: 'ok',
    recordedAt: at,
    usage: {
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: tokens,
      model: 'claude-opus-5',
      estimated: false,
    },
  });
}

function lastState(panel: FakePanel): UsageState {
  const last = panel.posted[panel.posted.length - 1];
  if (!last || last.type !== 'state') throw new Error('no state pushed');
  return last.state;
}

const NOW = (): Date => new Date('2026-08-01T12:00:00.000Z');

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (1, ?)').run('karst');
});
afterEach(() => store.close());

describe('UsagePanelManager', () => {
  it('pushes state as soon as the panel opens', () => {
    store.db.prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (1, ?, ?, 1)').run(
      'K-1',
      'One',
    );
    seed(1, 500);
    const host = fakeHost();
    new UsagePanelManager(store, host, { projectId: () => 1, now: NOW }).open();
    expect(host.panels).toHaveLength(1);
    expect(lastState(host.panels[0]!).totals.totalExact).toBe('500');
  });

  it('reveals the one panel instead of opening a second', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    mgr.open();
    expect(host.panels).toHaveLength(1);
    expect(host.panels[0]!.revealed).toBe(1);
  });

  it('re-creates the panel after it is disposed', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    host.panels[0]!.dispose();
    mgr.open();
    expect(host.panels).toHaveLength(2);
  });

  it('holds the filter selection host-side and re-pushes on every change', () => {
    seed(null, 10, '2026-08-01T06:00:00.000Z');
    seed(null, 900, '2026-06-01T00:00:00.000Z');
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    const panel = host.panels[0]!;

    panel.emit({ type: 'set-range', range: '24h' });
    expect(lastState(panel).rangeId).toBe('24h');
    expect(lastState(panel).totals.totalExact).toBe('10');

    panel.emit({ type: 'set-range', range: 'all' });
    expect(lastState(panel).totals.totalExact).toBe('910');

    panel.emit({ type: 'set-sort', sort: 'calls' });
    expect(lastState(panel).sort).toBe('calls');
  });

  it('opens on the store’s default sort rather than pinning its own', () => {
    const host = fakeHost();
    new UsagePanelManager(store, host, { projectId: () => 1, now: NOW }).open();
    // A second default here would silently outrank the one the query layer
    // states, and this one was 'total' — the ranking the ticket was about.
    expect(lastState(host.panels[0]!).sort).toBe(DEFAULT_USAGE_SORT);
  });

  it('resets the page when the range or sort changes — the old offset can be past the end', () => {
    for (let i = 1; i <= 4; i++) {
      store.db
        .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, 1)')
        .run(i, `K-${i}`, `T${i}`);
      seed(i, i * 10);
    }
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    const panel = host.panels[0]!;
    panel.emit({ type: 'set-page', offset: 2 });
    expect(lastState(panel).page.offset).toBe(2);
    panel.emit({ type: 'set-range', range: '7d' });
    expect(lastState(panel).page.offset).toBe(0);
  });

  it('ignores a message it cannot narrow rather than querying with it', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    const panel = host.panels[0]!;
    panel.emit({ type: 'set-range', range: "'; DROP TABLE token_usage; --" });
    expect(lastState(panel).rangeId).toBe('30d');
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='token_usage'").get())
      .toBeDefined();
  });

  it('opens a ticket’s dashboard from a table row', () => {
    const openDashboard = vi.fn();
    const host = fakeHost();
    new UsagePanelManager(store, host, { projectId: () => 1, openDashboard, now: NOW }).open();
    host.panels[0]!.emit({ type: 'open-dashboard', ticketId: 12 });
    expect(openDashboard).toHaveBeenCalledWith(12);
  });

  it('never lets one bad message kill the pump', () => {
    const logError = vi.fn();
    const host = fakeHost();
    new UsagePanelManager(store, host, {
      projectId: () => 1,
      now: NOW,
      logError,
      openDashboard: () => {
        throw new Error('boom');
      },
    }).open();
    const panel = host.panels[0]!;
    expect(() => panel.emit({ type: 'open-dashboard', ticketId: 1 })).not.toThrow();
    expect(logError).toHaveBeenCalled();
    // Still alive.
    panel.emit({ type: 'request-state' });
    expect(panel.posted.length).toBeGreaterThan(1);
  });

  it('posts exactly one action-result per parsed request that carries a requestId (UI-R13)', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    const panel = host.panels[0]!;
    panel.emit({ type: 'set-range', range: '24h', requestId: 'r1' });
    const results = panel.posted.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('posts no action-result for a message with no requestId (back-compat)', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    mgr.open();
    const panel = host.panels[0]!;
    panel.emit({ type: 'set-range', range: '24h' });
    expect(panel.posted.some((m) => m.type === 'action-result')).toBe(false);
  });

  it('reports a thrown action as ok:false with its message, and logs it', () => {
    const logError = vi.fn();
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, {
      projectId: () => 1,
      now: NOW,
      logError,
      openDashboard: () => {
        throw new Error('boom');
      },
    });
    mgr.open();
    const panel = host.panels[0]!;
    panel.emit({ type: 'open-dashboard', ticketId: 1, requestId: 'r2' });
    const results = panel.posted.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r2', ok: false, message: 'boom' }]);
    expect(logError).toHaveBeenCalledWith('karst: token-usage action failed', expect.any(Error));
  });

  it('refresh before open is a safe no-op', () => {
    const host = fakeHost();
    const mgr = new UsagePanelManager(store, host, { projectId: () => 1, now: NOW });
    expect(() => mgr.refresh()).not.toThrow();
    expect(host.panels).toHaveLength(0);
  });
});
