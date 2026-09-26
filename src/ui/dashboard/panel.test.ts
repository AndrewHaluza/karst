import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStore, type NestableStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketFields } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { manifest, processes, review, runnableRepo } from '../../manifest/fixtures.js';
import { recordFindings } from '../../store/reviewFindings.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import { openStageRun } from '../../store/stageRuns.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { attemptKey } from '../../model/inside/rounds.js';
import { DashboardManager, type PanelHost, type FakePanel, type StageLogReader, type AgentLogReader } from './panel.js';
import { buildGraphInsideInput } from './graphInside.js';
import { LIVE_TICK_MS } from './liveTick.js';
import { ACTION_GRACE_MS } from './panel.js';
import type { WorktreeStats, WorktreeStatsLoader } from './worktreeStats.js';
import type { GateOptions, GateOptionsLoader } from './gateOptions.js';

const PANEL_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'panel.ts'),
  'utf8',
);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** In-memory PanelHost double: records created panels + messages. */
function fakeHost(): { host: PanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  const host: PanelHost = {
    createPanel: (title, _ticketId, preserveFocus) => {
      const messageHandlers: Array<(m: unknown) => void> = [];
      const viewStateHandlers: Array<(active: boolean) => void> = [];
      const panel: FakePanel = {
        title,
        revealed: 0,
        createdPreserveFocus: preserveFocus,
        revealedPreserveFocus: [],
        disposed: false,
        visible: true,
        posted: [],
        icons: [],
        messageHandlers,
        viewStateHandlers,
        reveal: (keepFocus) => {
          panel.revealed++;
          panel.revealedPreserveFocus.push(keepFocus);
        },
        setIcon: (p) => panel.icons.push(p),
        isVisible: () => panel.visible,
        postMessage: (m) => panel.posted.push(m),
        onDidReceiveMessage: (h) => messageHandlers.push(h),
        onDidChangeViewState: (h) => viewStateHandlers.push(h),
        onDidDispose: (h) => (panel.disposeHandler = h),
        dispose: () => {
          panel.disposed = true;
          panel.disposeHandler?.();
        },
        emit: (m) => messageHandlers.forEach((h) => h(m)),
        emitViewState: (active) => viewStateHandlers.forEach((h) => h(active)),
      };
      panels.push(panel);
      return panel;
    },
  };
  return { host, panels };
}

describe('DashboardManager', () => {
  let store: NestableStore;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('opening the same ticket twice reveals the existing panel (one per id)', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    mgr.openDashboard(t.id);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBeGreaterThanOrEqual(1);
  });

  it('titles the panel with the ticket key + title, not the raw id', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    expect(panels[0]!.title).toBe('PROJ-9 — ship it');
  });

  it('prefixes the panel title with the one-char marker for a follow-up ticket', () => {
    const parent = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const child = createTicket(store, {
      key: 'PROJ-9-fu1',
      title: 'ship it',
      parentTicketId: parent.id,
    });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(child.id);
    expect(panels[0]!.title).toBe('↳ PROJ-9-fu1 — ship it');
  });

  it('posts switchable agent-session state for a live impl session', () => {
    const t = createTicket(store, { key: 'SW-1', title: 'switch' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);

    const message = panels[0]!.posted.find((m: any) => m.type === 'state') as any;
    expect(message.state.agentSession.canSwitch).toBe(true);
  });

  it('posts switchable agent-session state for a settled stage with no live session', () => {
    const t = createTicket(store, { key: 'SW-2', title: 'switch' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);

    const message = panels[0]!.posted.find((m: any) => m.type === 'state') as any;
    expect(message.state.agentSession.canSwitch).toBe(true);
  });

  it('pushes the manifest’s uat fix budget into the rail’s retry meter', () => {
    // The meter draws one tick per allowed attempt, so a cap resolved anywhere
    // but from the live manifest is a different number from the one the driver
    // will actually spend.
    const t = createTicket(store, { key: 'CAP-1', title: 'capped' });
    setStage(store, t.id, 'uat', { status: 'failed', attempt: 1 });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      () => 1,
    );

    mgr.openDashboard(t.id);

    const message = panels[0]!.posted.find((m: any) => m.type === 'state') as any;
    const uat = message.state.rail.main.find((s: any) => s.cell.stageKey === 'uat');
    expect(uat.retry).toMatchObject({ spent: 1, cap: 1 });
  });

  it('sets the tab icon on open and on each state push, from iconFor', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(
      store,
      host,
      () => ({}) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => '/store/icons/karst-blue.svg',
    );

    mgr.openDashboard(t.id);
    mgr.pushState(t.id);

    expect(panels[0]!.icons).toContain('/store/icons/karst-blue.svg');
    // Open pushes state once, then the explicit push — the icon re-points each time.
    expect(panels[0]!.icons.length).toBeGreaterThanOrEqual(2);
  });

  it('separate tickets get separate panels', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(a.id);
    mgr.openDashboard(b.id);
    expect(panels).toHaveLength(2);
  });

  it('opening a dashboard pushes initial state to the webview', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    const stateMsgs = panels[0]!.posted.filter((m: any) => m.type === 'state');
    expect(stateMsgs).toHaveLength(1);
    expect((stateMsgs[0] as any).state.ticketId).toBe(t.id);
  });

  it('pushState(ticketId) posts a fresh state message to that ticket panel only', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    mgr.openDashboard(a.id);
    mgr.openDashboard(b.id);

    const before = panels[1]!.posted.length;
    mgr.pushState(a.id);
    expect(panels[0]!.posted.filter((m: any) => m.type === 'state')).toHaveLength(2);
    expect(panels[1]!.posted.length).toBe(before); // b untouched
  });

  it('pushState on an unopened ticket is a no-op', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    expect(() => mgr.pushState(t.id)).not.toThrow();
  });

  it('pushStoreState reports store news without restarting supplemental loaders', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const loadStats: WorktreeStatsLoader = vi.fn(
      () => new Promise<WorktreeStats[]>(() => {}),
    );
    const loadGateOptions: GateOptionsLoader = vi.fn(
      () => new Promise<GateOptions>(() => {}),
    );
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, loadStats, undefined, loadGateOptions,
    );
    mgr.openDashboard(t.id);

    mgr.pushStoreState(t.id);

    const stateMessages = panels[0]!.posted.filter(
      (message): message is {
        type: 'state';
        live?: boolean;
        supplemental?: boolean;
        settlesActions?: boolean;
      } =>
        typeof message === 'object' && message !== null && (message as { type?: string }).type === 'state',
    );
    expect(stateMessages).toHaveLength(2);
    expect(stateMessages[1]!.live).toBeUndefined();
    expect(stateMessages[1]!.supplemental).toBe(false);
    expect(stateMessages[1]!.settlesActions).toBe(false);
    expect(loadStats).toHaveBeenCalledOnce();
    expect(loadGateOptions).toHaveBeenCalledOnce();
  });

  it('pushPassiveState reloads supplemental facts without settling dashboard actions', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const loadStats: WorktreeStatsLoader = vi.fn(async () => []);
    const loadGateOptions: GateOptionsLoader = vi.fn(async () => ({ uat: [], review: [] }));
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, loadStats, undefined, loadGateOptions,
    );
    mgr.openDashboard(t.id);

    mgr.pushPassiveState(t.id);

    const stateMessages = panels[0]!.posted.filter(
      (message): message is {
        type: 'state';
        supplemental?: boolean;
        settlesActions?: boolean;
      } =>
        typeof message === 'object' && message !== null && (message as { type?: string }).type === 'state',
    );
    expect(stateMessages).toHaveLength(2);
    expect(stateMessages[1]!.supplemental).toBeUndefined();
    expect(stateMessages[1]!.settlesActions).toBe(false);
    expect(loadStats).toHaveBeenCalledTimes(2);
    expect(loadGateOptions).toHaveBeenCalledTimes(2);
  });

  it('keeps the gate-options follow-up passive after a passive state refresh', async () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const loadStats: WorktreeStatsLoader = vi.fn(
      () => new Promise<WorktreeStats[]>(() => {}),
    );
    const loadGateOptions: GateOptionsLoader = vi.fn(async () => ({
      uat: [{ name: 'e2e', disabled: false }],
      review: [],
    }));
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, loadStats, undefined, loadGateOptions,
    );
    mgr.openDashboard(t.id);

    mgr.pushPassiveState(t.id);

    await vi.waitFor(() => {
      const messages = panels[0]!.posted.filter(
        (message): message is { type: 'state'; settlesActions?: boolean } =>
          typeof message === 'object'
          && message !== null
          && (message as { type?: string }).type === 'state',
      );
      expect(messages).toHaveLength(3);
      expect(messages.slice(1).map((message) => message.settlesActions)).toEqual([
        false,
        false,
      ]);
    });
  });

  it('a stop-server webview message dispatches to the supervisor action', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const stopServer = vi.fn();
    const mgr = new DashboardManager(store, host, () => ({ stopServer }) as never);

    mgr.openDashboard(t.id);
    panels[0]!.emit({ type: 'stop-server', serverId: 9 });
    expect(stopServer).toHaveBeenCalledWith(9);
  });

  it('posts a generic inside-progress event to the open panel (transient, not a state push)', () => {
    // Finding 12: live Ship rides the SAME generic inside-progress union as
    // gates and Fix — the manager has no ship-specific progress channel at all.
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    panels[0]!.posted.length = 0; // drop the open-time state push
    mgr.postInsideProgress(t.id, {
      kind: 'active',
      ticketId: t.id,
      stage: 'ship',
      processId: 'ship',
      live: { status: 'run', label: 'Shipping' },
    });

    expect(panels[0]!.posted).toEqual([
      {
        type: 'inside-progress',
        event: {
          kind: 'active',
          ticketId: t.id,
          stage: 'ship',
          processId: 'ship',
          live: { status: 'run', label: 'Shipping' },
        },
      },
    ]);
  });

  it('postInsideProgress on an unopened ticket is a no-op', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    expect(() =>
      mgr.postInsideProgress(t.id, {
        kind: 'cleared',
        ticketId: t.id,
        stage: 'ship',
        processId: 'ship',
      }),
    ).not.toThrow();
  });

  it('supplies real service names and process assignments to the inside views', () => {
    // Manifest with one runnable repo scoped to the ticket, and processes.uatTester
    // configured — the explicit model keeps `configured.model` a real string.
    const t = createTicket(store, { key: 'T', title: 't' });
    updateTicketFields(store, t.id, { selectedRepos: ['svc-a'] });
    const m = manifest(
      { 'svc-a': runnableRepo() },
      { processes: processes({ uatTester: { provider: 'codex', model: 'gpt-5' } }) },
    );
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(
      store,
      host,
      () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => m,
    );

    mgr.openDashboard(t.id);

    const state = (panels[0]!.posted.find((msg: any) => msg.type === 'state') as any).state;
    const uat = state.insideViews.uat;
    const tester = uat.processes.find((p: any) => p.id === 'tester');
    expect(tester?.configuredExecution).toMatchObject({ provider: 'codex', model: expect.any(String) });
    const services = uat.processes.find((p: any) => p.id === 'services');
    expect(services?.detail).not.toBe('');
  });

  it('stays silent on the ship-findings row when the findings lane is disabled (Task 4.1 fix round 1, ruling 4)', () => {
    // The shipped example config's alternative to lowering blockingSeverity
    // is `enabled: false` — the lane records no findings at all when off, so
    // a leftover high blockingSeverity beside it must not light up a row
    // nothing on record can ever satisfy.
    const t = createTicket(store, { key: 'FD-1', title: 'findings disabled' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'review', { attempt: 1 });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 1,
      runAt: '2026-09-01T00:00:00.000Z',
      findings: [{ severity: 'high', repo: '', title: 'stale', detail: '', source: 'agent' }],
    });
    const m = manifest(
      {},
      { review: review({ findings: { enabled: false, blockingSeverity: 'high', maxFindings: 50 } }) },
    );
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(
      store,
      host,
      () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => m,
    );

    mgr.openDashboard(t.id);

    const state = (panels[0]!.posted.find((msg: any) => msg.type === 'state') as any).state;
    const ship = state.insideViews.ship;
    expect(ship.processes.find((p: any) => p.id === 'ship-findings')).toBeUndefined();
  });

  it('reports a rejected inside action as a failure, not a success', () => {
    const t = createTicket(store, { key: 'F4', title: 'inside outcome' });
    const { host, panels } = fakeHost();
    let mgr!: DashboardManager;
    mgr = new DashboardManager(
      store,
      host,
      () => ({ insideAction: (actionId: string) => mgr.dispatchInsideAction(t.id, actionId) }) as never,
    );
    mgr.openDashboard(t.id);
    panels[0]!.posted.length = 0; // drop the open-time state push
    panels[0]!.emit({ type: 'inside-action', actionId: 'stale-action-id', requestId: 'r1' });
    const posted = panels[0]!.posted.find((m: any) => m.type === 'action-result');
    expect(posted).toMatchObject({ type: 'action-result', ok: false });
  });

  it('mints a registry-backed discard action for an ambiguous node run and dispatches it to the host', () => {
    // Slice 4 Task 4: the panel wires the graph projection's attach closure to
    // THIS snapshot's registry, so an ambiguous node run's discard exit is a
    // dispatchable capability — and dispatching it reaches the host's
    // graphDiscardNode (the discard transaction itself is the status gate).
    const t = createTicket(store, { key: 'GD', title: 'discard' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
        )
        .run(t.id)
        .lastInsertRowid,
    );
    const revisionId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId)
        .lastInsertRowid,
    );
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, 'worker', 'agent', 1, 'termination-unknown')`,
      )
      .run(graphRunId, revisionId);

    const { host, panels } = fakeHost();
    const discarded: Array<[number, number]> = [];
    const insideHost = {
      openPr: () => undefined,
      graphDiscardNode: (ticketId: number, nodeRunId: number) => {
        discarded.push([ticketId, nodeRunId]);
      },
    } as never;
    let mgr!: DashboardManager;
    mgr = new DashboardManager(
      store, host, () => ({ insideAction: (actionId: string) => mgr.dispatchInsideAction(t.id, actionId) }) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, insideHost,
      undefined, undefined, undefined,
      (ticketId) =>
        buildGraphInsideInput(
          {
            store,
            manifest: () => undefined,
            liveSessions: () => [],
            now: () => '2026-08-12T00:00:00.000Z',
          },
          ticketId,
        ),
    );

    mgr.openDashboard(t.id);

    const state = (panels[0]!.posted.find((msg: any) => msg.type === 'state') as any).state;
    const graph = state.insideViews.impl.processes.find((p: any) => p.id === 'graph');
    const nodeRow = graph.evidence.nodes.find((n: any) => n.nodeId === 'worker');
    expect(nodeRow.action).toMatchObject({ kind: 'graph-discard-node' });
    const actionId = nodeRow.action.actionId;
    expect(actionId).toMatch(/^snapshot-1:action-\d+$/);

    panels[0]!.posted.length = 0;
    panels[0]!.emit({ type: 'inside-action', actionId, requestId: 'r1' });
    expect(discarded).toEqual([[t.id, 1]]);
  });

  it('mints a registry-backed override-edit action for an editable agent node and dispatches it (Slice 6 T4)', () => {
    const t = createTicket(store, { key: 'GE', title: 'edit override' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
        )
        .run(t.id)
        .lastInsertRowid,
    );
    const revisionId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId)
        .lastInsertRowid,
    );
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, 'blocked-agent', 'agent', 1, 'blocked')`,
      )
      .run(graphRunId, revisionId);

    const { host, panels } = fakeHost();
    const edited: Array<[number, number]> = [];
    const insideHost = {
      openPr: () => undefined,
      graphEditOverride: (ticketId: number, nodeRunId: number) => {
        edited.push([ticketId, nodeRunId]);
      },
    } as never;
    let mgr!: DashboardManager;
    mgr = new DashboardManager(
      store, host, () => ({ insideAction: (actionId: string) => mgr.dispatchInsideAction(t.id, actionId) }) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, insideHost,
      undefined, undefined, undefined,
      (ticketId) =>
        buildGraphInsideInput(
          {
            store,
            manifest: () => undefined,
            liveSessions: () => [],
            now: () => '2026-08-12T00:00:00.000Z',
          },
          ticketId,
        ),
    );

    mgr.openDashboard(t.id);

    const state = (panels[0]!.posted.find((msg: any) => msg.type === 'state') as any).state;
    const graph = state.insideViews.impl.processes.find((p: any) => p.id === 'graph');
    const nodeRow = graph.evidence.nodes.find((n: any) => n.nodeId === 'blocked-agent');
    // The projection mints the edit-override control ONLY on an editable agent
    // node; the registry makes it a dispatchable capability.
    expect(nodeRow.action).toMatchObject({ kind: 'graph-edit-override' });
    const actionId = nodeRow.action.actionId;
    expect(actionId).toMatch(/^snapshot-1:action-\d+$/);

    panels[0]!.posted.length = 0;
    panels[0]!.emit({ type: 'inside-action', actionId, requestId: 'r1' });
    expect(edited).toEqual([[t.id, 1]]);
  });

  it('drops a malformed inside-progress event at the panel boundary', () => {
    // The webview is a trust boundary in both directions: an event the
    // renderer cannot handle (a live status outside run/wait/fail) never ships.
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    panels[0]!.posted.length = 0;
    mgr.postInsideProgress(t.id, {
      kind: 'active',
      ticketId: t.id,
      stage: 'ship',
      processId: 'ship',
      live: { status: 'pass', label: 'Shipping' },
    } as never);

    expect(panels[0]!.posted.some((m: any) => m.type === 'inside-progress')).toBe(false);
  });

  it('no longer exposes the legacy ship-progress plumbing', () => {
    // The per-repo/per-step channel and its panel method are gone (Finding 12);
    // ship progress flows exclusively through postInsideProgress.
    expect(PANEL_SOURCE).not.toMatch(/ship-progress|postShipProgress/);
  });

  it('disposing a panel drops it from the map so reopen creates a new one', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    panels[0]!.dispose();
    mgr.openDashboard(t.id);
    expect(panels).toHaveLength(2);
  });

  describe('change-base-ref', () => {
    const addWorktree = (ticketId: number, baseRef = 'develop'): void => {
      store.db
        .prepare(
          'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ticketId, '/repo/a', '/wt/a', 'karst/A', baseRef);
    };

    it('calls changeBaseRef and reports a refusal without changing the stored base', async () => {
      const t = createTicket(store, { key: 'CB1', title: 'change base' });
      addWorktree(t.id, 'develop');
      const { host, panels } = fakeHost();
      const changeBaseRef = vi.fn().mockResolvedValue({
        ok: false,
        message: 'the worktree has uncommitted changes',
      });
      const mgr = new DashboardManager(store, host, () => ({ changeBaseRef }) as never);
      mgr.openDashboard(t.id);
      panels[0]!.posted.length = 0; // drop the open-time state push
      panels[0]!.emit({
        type: 'change-base-ref',
        repo: '/repo/a',
        baseRef: 'epic/x',
        rebase: true,
        requestId: 'r1',
      });
      await vi.waitFor(() =>
        expect(panels[0]!.posted.find((m: any) => m.type === 'action-result')).toBeDefined(),
      );
      expect(changeBaseRef).toHaveBeenCalledWith('/repo/a', 'epic/x', true);
      const result = panels[0]!.posted.find((m: any) => m.type === 'action-result');
      expect(result).toMatchObject({
        type: 'action-result',
        requestId: 'r1',
        ok: false,
        message: 'the worktree has uncommitted changes',
      });
      // No repaint carrying a new base — the ticket keeps its old base.
      expect(panels[0]!.posted.some((m: any) => m.type === 'state')).toBe(false);
      const row = store.db
        .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ?')
        .get(t.id) as { base_ref: string };
      expect(row.base_ref).toBe('develop');
    });

    it('repaints the scope card with the new base after a successful change', async () => {
      const t = createTicket(store, { key: 'CB2', title: 'change base' });
      addWorktree(t.id, 'develop');
      const { host, panels } = fakeHost();
      const changeBaseRef = vi.fn().mockImplementation(async () => {
        // The real `changeBaseRef` workflow writes the new base before
        // resolving; the fake mirrors that ordering so the repaint has
        // something new to show.
        store.db
          .prepare('UPDATE worktrees SET base_ref = ? WHERE ticket_id = ? AND repo = ?')
          .run('epic/x', t.id, '/repo/a');
        return { ok: true, message: 'Rebased onto epic/x' };
      });
      const mgr = new DashboardManager(store, host, () => ({ changeBaseRef }) as never);
      mgr.openDashboard(t.id);
      panels[0]!.posted.length = 0;
      panels[0]!.emit({
        type: 'change-base-ref',
        repo: '/repo/a',
        baseRef: 'epic/x',
        rebase: true,
        requestId: 'r2',
      });
      await vi.waitFor(() =>
        expect(panels[0]!.posted.find((m: any) => m.type === 'action-result')).toBeDefined(),
      );
      const result = panels[0]!.posted.find((m: any) => m.type === 'action-result');
      expect(result).toMatchObject({ type: 'action-result', requestId: 'r2', ok: true });
      const pushed = panels[0]!.posted.find((m: any) => m.type === 'state') as any;
      expect(pushed).toBeDefined();
      expect(pushed.state.worktrees[0]).toMatchObject({ repo: '/repo/a', baseRef: 'epic/x' });
    });
  });

  describe('worktree stats', () => {
    const addWorktree = (ticketId: number): void => {
      store.db
        .prepare(
          'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ticketId, '/repo/a', '/wt/a', 'karst/A', 'develop');
    };

    it('posts loaded worktree stats after the synchronous state', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      addWorktree(t.id);
      const { host, panels } = fakeHost();
      const loadStats = vi
        .fn()
        .mockResolvedValue([{ repo: '/repo/a', additions: 8, deletions: 3 }]);
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        loadStats,
      );

      mgr.openDashboard(t.id);

      await vi.waitFor(() =>
        expect(panels[0]!.posted).toContainEqual({
          type: 'worktree-stats',
          stats: [{ repo: '/repo/a', additions: 8, deletions: 3 }],
        }),
      );
      expect(loadStats).toHaveBeenCalledWith(
        [expect.objectContaining({ repo: '/repo/a', path: '/wt/a', baseRef: 'develop' })],
        expect.any(AbortSignal),
      );
    });

    it('drops an older stats response after a newer state request wins', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      addWorktree(t.id);
      const first = deferred<WorktreeStats[]>();
      const second = deferred<WorktreeStats[]>();
      const signals: AbortSignal[] = [];
      const loadStats: WorktreeStatsLoader = vi.fn((_worktrees, signal) => {
        signals.push(signal!);
        return signals.length === 1 ? first.promise : second.promise;
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        loadStats,
      );
      mgr.openDashboard(t.id);
      mgr.pushState(t.id);

      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);

      second.resolve([{ repo: '/repo/a', additions: 2, deletions: 1 }]);
      await vi.waitFor(() =>
        expect(panels[0]!.posted).toContainEqual({
          type: 'worktree-stats',
          stats: [{ repo: '/repo/a', additions: 2, deletions: 1 }],
        }),
      );
      first.resolve([{ repo: '/repo/a', additions: 99, deletions: 99 }]);
      await Promise.resolve();

      expect(panels[0]!.posted.filter((m: any) => m.type === 'worktree-stats')).toEqual([
        {
          type: 'worktree-stats',
          stats: [{ repo: '/repo/a', additions: 2, deletions: 1 }],
        },
      ]);
    });

    it('does not post late stats to a disposed panel', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      addWorktree(t.id);
      const pending = deferred<WorktreeStats[]>();
      let signal: AbortSignal | undefined;
      const loadStats: WorktreeStatsLoader = (_worktrees, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      };
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        loadStats,
      );
      mgr.openDashboard(t.id);
      panels[0]!.dispose();

      expect(signal?.aborted).toBe(true);

      pending.resolve([{ repo: '/repo/a', additions: 1, deletions: 1 }]);
      await Promise.resolve();

      expect(panels[0]!.posted.filter((m: any) => m.type === 'worktree-stats')).toEqual([]);
    });

    it('logs an unexpected loader rejection without killing the panel pump', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      addWorktree(t.id);
      const error = new Error('loader failed');
      const logError = vi.fn();
      const { host } = fakeHost();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        logError,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => Promise.reject(error),
      );

      mgr.openDashboard(t.id);

      await vi.waitFor(() =>
        expect(logError).toHaveBeenCalledWith('karst: dashboard worktree stats failed', error),
      );
      expect(mgr.isOpen(t.id)).toBe(true);
    });
  });

  describe('gate options', () => {
    it('pushes gate options after the state push', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => ({ uat: [{ name: 'e2e', disabled: true }], review: [] }),
      );

      mgr.openDashboard(t.id);

      await vi.waitFor(() =>
        expect(panels[0]!.posted).toContainEqual({
          type: 'gate-options',
          options: { uat: [{ name: 'e2e', disabled: true }], review: [] },
        }),
      );
    });

    it('does not post gate options to a panel that has been disposed', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const pending = deferred<{ uat: never[]; review: never[] }>();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => pending.promise,
      );

      mgr.openDashboard(t.id);
      panels[0]!.dispose();
      pending.resolve({ uat: [], review: [] });
      await Promise.resolve();
      await Promise.resolve();

      expect(panels[0]!.posted.some((p: any) => p.type === 'gate-options')).toBe(false);
    });

    it('never posts a stale gate-options result after a newer state push', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const resolvers: Array<(v: { uat: never[]; review: never[] }) => void> = [];
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => new Promise((r) => resolvers.push(r)),
      );

      mgr.openDashboard(t.id);
      mgr.pushState(t.id);

      resolvers[1]!({ uat: [], review: [] });
      resolvers[0]!({ uat: [], review: [] });
      await Promise.resolve();
      await Promise.resolve();

      expect(panels[0]!.posted.filter((p: any) => p.type === 'gate-options')).toHaveLength(1);
    });

    it('logs and posts nothing when gate resolution rejects', async () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const logged: unknown[] = [];
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store,
        host,
        () => ({}) as never,
        undefined,
        undefined,
        undefined,
        (m: string) => logged.push(m),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error('probe blew up');
        },
      );

      mgr.openDashboard(t.id);

      await vi.waitFor(() => expect(logged).toHaveLength(1));
      expect(panels[0]!.posted.some((p: any) => p.type === 'gate-options')).toBe(false);
    });
  });

  describe('terminal binding', () => {
    const bind = (
      enabled: boolean,
      onDidActivate: (ticketId: number, active: boolean) => void = () => {},
    ) => ({ enabled: () => enabled, onDidActivate });

    it('tells a new panel where the binding currently sits', () => {
      // The preference is host-owned and window-wide, so the webview renders
      // what it is pushed rather than remembering its own copy.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        bind(true),
      );

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'bind', enabled: true });
    });

    it('reports unbound when the host declares no binding at all', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'bind', enabled: false });
    });

    it('pushBind reaches every open panel, not just the one that toggled', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      const b = createTicket(store, { key: 'B', title: 'b' });
      const { host, panels } = fakeHost();
      let on = false;
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { enabled: () => on, onDidActivate: () => {} },
      );

      mgr.openDashboard(a.id);
      mgr.openDashboard(b.id);
      on = true;
      mgr.pushBind();

      for (const panel of panels) {
        expect(panel.posted).toContainEqual({ type: 'bind', enabled: true });
      }
    });

    it('forwards panel activation, both gaining and losing it', () => {
      // Losing activation is forwarded rather than filtered here: the panel
      // reports what happened, the binder decides what it means.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        bind(true, (ticketId, active) => seen.push([ticketId, active])),
      );

      mgr.openDashboard(t.id);
      panels[0]!.emitViewState(true);
      panels[0]!.emitViewState(false);

      expect(seen).toEqual([[t.id, true], [t.id, false]]);
    });

    it('creates and reveals without focus when the binding asked for it', () => {
      // A bound reveal happens because the user clicked the TERMINAL. Taking
      // focus would yank the caret out of the shell they are typing into.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.createdPreserveFocus).toBe(true);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.revealedPreserveFocus).toEqual([true]);
    });

    it('takes focus on an ordinary open, as it always did', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      mgr.openDashboard(t.id);

      expect(panels[0]!.createdPreserveFocus).toBeUndefined();
      expect(panels[0]!.revealedPreserveFocus).toEqual([undefined]);
    });
  });

  describe('live snapshot ticks', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const states = (panel: FakePanel): unknown[] =>
      panel.posted.filter((m) => (m as { type?: string }).type === 'state');

    it('re-pushes the snapshot every second while a process is running', () => {
      // The inside block reads store rows nothing pushes when they OPEN — a
      // tester run, a findings lane, a running gate. Without this tick the
      // panel shows the state it had when the stage last moved.
      const t = createTicket(store, { key: 'A', title: 'a' });
      setStage(store, t.id, 'uat', { status: 'running', startedAt: new Date().toISOString() });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      const initial = states(panels[0]!).length;
      vi.advanceTimersByTime(LIVE_TICK_MS * 3);

      expect(states(panels[0]!).length).toBe(initial + 3);
    });

    it('stops ticking once nothing is running', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const run = openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      finishProcessRun(store, run.id, 'passed', new Date().toISOString());
      vi.advanceTimersByTime(LIVE_TICK_MS);
      const settled = states(panels[0]!).length;
      vi.advanceTimersByTime(LIVE_TICK_MS * 5);

      expect(states(panels[0]!).length).toBe(settled);
    });

    it('never ticks a settled ticket at all', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      const initial = states(panels[0]!).length;
      vi.advanceTimersByTime(LIVE_TICK_MS * 10);

      expect(states(panels[0]!).length).toBe(initial);
    });

    it('is a snapshot repaint only — it never re-runs the git/filesystem loaders', async () => {
      // The supplemental loaders spawn `git` per worktree and walk the repo
      // for gate scripts. Re-running them once a second (aborting the previous
      // one each time) would spawn a child process per second that never gets
      // to finish — the repaint reads the store and nothing else.
      const t = createTicket(store, { key: 'A', title: 'a' });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host } = fakeHost();
      const loadStats: WorktreeStatsLoader = vi.fn().mockResolvedValue([]);
      const loadGateOptions = vi.fn().mockResolvedValue({ uat: [], review: [] });
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, loadStats, undefined, loadGateOptions,
      );

      mgr.openDashboard(t.id);
      const statsCalls = (loadStats as ReturnType<typeof vi.fn>).mock.calls.length;
      const gateCalls = loadGateOptions.mock.calls.length;
      vi.advanceTimersByTime(LIVE_TICK_MS * 5);

      expect((loadStats as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(statsCalls);
      expect(loadGateOptions.mock.calls).toHaveLength(gateCalls);
    });

    it('stops repainting a panel nobody can see, and catches up when it returns', () => {
      // Visibility, not activation: a dashboard watched beside a terminal the
      // user types in is visible and inactive, and that is the whole scenario.
      const t = createTicket(store, { key: 'A', title: 'a' });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      panels[0]!.visible = false;
      panels[0]!.emitViewState(false);
      const hidden = states(panels[0]!).length;
      vi.advanceTimersByTime(LIVE_TICK_MS * 5);
      expect(states(panels[0]!).length).toBe(hidden);

      panels[0]!.visible = true;
      panels[0]!.emitViewState(false); // visible again, still not the active tab
      expect(states(panels[0]!).length).toBe(hidden + 1);
      vi.advanceTimersByTime(LIVE_TICK_MS);
      expect(states(panels[0]!).length).toBe(hidden + 2);
    });

    it('marks a repaint `live` so the webview can defer it, and a real push not', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      vi.advanceTimersByTime(LIVE_TICK_MS);
      const pushed = states(panels[0]!) as Array<{ live?: boolean }>;

      expect(pushed[0]!.live).toBeUndefined();
      expect(pushed[1]!.live).toBe(true);
    });

    it('keeps an id dispatchable across live repaints — a repaint is not a supersede', () => {
      // A live repaint re-reads the same snapshot and the webview updates clocks
      // in place without re-rendering its rows, so the ids it displays must stay
      // live for as long as a run ticks (869eja6uv). Only a real push — which
      // re-renders the webview with freshly minted ids — supersedes.
      const t = createTicket(store, { key: 'A', title: 'a' });
      store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
      store.db
        .prepare(
          `INSERT INTO prs (ticket_id, repo, number, url, status, merged_at)
           VALUES (?, ?, ?, ?, 'merged', ?)`,
        )
        .run(t.id, '/repo/a', 12, 'https://github.com/o/r/pull/12', new Date().toISOString());
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { openPr: () => {} } as never,
      );

      mgr.openDashboard(t.id);
      const actionId = /"actionId":"(snapshot-1:action-\d+)"/.exec(
        JSON.stringify(panels[0]!.posted),
      )?.[1];
      expect(actionId).toBeDefined();

      // A long run: many repaints, no real push — the displayed id never ages
      // into the grace window.
      vi.advanceTimersByTime(LIVE_TICK_MS * 3);
      expect(mgr.dispatchInsideAction(t.id, actionId!)).toMatchObject({ ok: true });
      vi.advanceTimersByTime(ACTION_GRACE_MS * 3);
      expect(mgr.dispatchInsideAction(t.id, actionId!)).toMatchObject({ ok: true });
    });

    it('keeps a REAL-push-superseded id dispatchable only for the grace window', () => {
      // The grace window covers a webview→host round trip when a real push lands
      // between a render and the click. A real push re-renders the webview with
      // fresh ids, so the superseded ids expire once the window closes.
      const t = createTicket(store, { key: 'A', title: 'a' });
      store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
      store.db
        .prepare(
          `INSERT INTO prs (ticket_id, repo, number, url, status, merged_at)
           VALUES (?, ?, ?, ?, 'merged', ?)`,
        )
        .run(t.id, '/repo/a', 12, 'https://github.com/o/r/pull/12', new Date().toISOString());
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { openPr: () => {} } as never,
      );

      mgr.openDashboard(t.id);
      const actionId = /"actionId":"(snapshot-1:action-\d+)"/.exec(
        JSON.stringify(panels[0]!.posted),
      )?.[1];
      expect(actionId).toBeDefined();

      // A real push supersedes the registry; the old id is still dispatchable
      // within the window.
      mgr.pushState(t.id);
      expect(mgr.dispatchInsideAction(t.id, actionId!)).toMatchObject({ ok: true });

      // Past the window it is gone (a tick past the strict cutoff, like the
      // grace pruner's `<` comparison).
      vi.advanceTimersByTime(ACTION_GRACE_MS + LIVE_TICK_MS);
      expect(mgr.dispatchInsideAction(t.id, actionId!)).toMatchObject({ ok: false });
    });

    it('a disposed panel stops its tick — no timer outlives the panel', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      const atDispose = states(panels[0]!).length;
      panels[0]!.dispose();
      vi.advanceTimersByTime(LIVE_TICK_MS * 5);

      expect(states(panels[0]!).length).toBe(atDispose);
    });
  });

  describe('view activation reporting', () => {
    it('reports the ticket active as soon as a focus-taking open creates the panel', () => {
      // Creation focuses the panel and fires no `onDidChangeViewState` (that
      // event only fires on CHANGES), so the manager must report the
      // activation it just caused itself.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        (ticketId, active) => seen.push([ticketId, active]),
      );

      mgr.openDashboard(t.id);
      expect(seen).toEqual([[t.id, true]]);

      panels[0]!.emitViewState(true); // the (possibly redundant) real event
      expect(seen).toEqual([[t.id, true], [t.id, true]]);
    });

    it('does NOT report a preserve-focus reveal as activation', () => {
      // A preserve-focus reveal makes the panel VISIBLE, not active (the
      // terminal binding relies on that distinction) — so it must not light
      // the sidebar highlight either.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        (ticketId, active) => seen.push([ticketId, active]),
      );

      mgr.openDashboard(t.id, { preserveFocus: true });
      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(seen).toEqual([]);
    });

    it('reports a focus-taking reveal of an existing panel', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        (ticketId, active) => seen.push([ticketId, active]),
      );

      mgr.openDashboard(t.id);
      panels[0]!.emitViewState(false); // user moved away
      mgr.openDashboard(t.id); // plain re-open takes focus again
      expect(seen).toEqual([[t.id, true], [t.id, false], [t.id, true]]);
    });

    it('reports the ACTIVE panel losing focus when it is disposed (closing the focused tab)', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        (ticketId, active) => seen.push([ticketId, active]),
      );

      mgr.openDashboard(t.id);
      panels[0]!.dispose();

      expect(seen).toEqual([[t.id, true], [t.id, false]]);
    });
  });

  describe('stage log requests', () => {
    const makeHarness = (opts: { stageLogReader?: StageLogReader; agentLogReader?: AgentLogReader }): {
      manager: DashboardManager;
      posts: (ticketId: number) => unknown[];
    } => {
      // Ticket ids are minted sequentially from 1, so seven creations make 7
      // a real ticket the panel can open for.
      for (let i = 0; i < 7; i += 1) {
        createTicket(store, { key: `SLOG-${i + 1}`, title: `ticket ${i + 1}` });
      }
      const { host } = fakeHost();
      const byTicket = new Map<number, FakePanel>();
      const hostWithIds: PanelHost = {
        createPanel: (title, ticketId, preserveFocus) => {
          const panel = host.createPanel(title, ticketId, preserveFocus) as FakePanel;
          byTicket.set(ticketId, panel);
          return panel;
        },
      };
      const manager = new DashboardManager(
        store,
        hostWithIds,
        () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined,
        opts.stageLogReader,
        opts.agentLogReader,
      );
      manager.openDashboard(7);
      return { manager, posts: (ticketId) => byTicket.get(ticketId)?.posted ?? [] };
    };

    it('posts the reader result as a stage-log message to the ticket panel', () => {
      const { manager, posts } = makeHarness({
        stageLogReader: (ticketId, stage) =>
          ticketId === 7 && stage === 'uat'
            ? { kind: 'ok', content: 'gate output', truncated: false }
            : { kind: 'error', message: 'no log' },
      });
      manager.requestStageLog(7, 'uat');
      expect(posts(7)).toContainEqual({
        type: 'stage-log',
        stage: 'uat',
        result: { kind: 'ok', content: 'gate output', truncated: false },
      });
    });

    it('posts the agent-log reader result to the ticket panel', () => {
      const { manager, posts } = makeHarness({
        agentLogReader: (ticketId, processId) =>
          ticketId === 7 && processId === 'tester'
            ? { kind: 'ok', content: 'tester tail', truncated: false }
            : { kind: 'error', message: 'no log' },
      });
      manager.requestAgentLog(7, 'tester');
      expect(posts(7)).toContainEqual({
        type: 'agent-log',
        processId: 'tester',
        result: { kind: 'ok', content: 'tester tail', truncated: false },
      });
    });

    it('posts an agent-log reader error result verbatim', () => {
      const { manager, posts } = makeHarness({
        agentLogReader: () => ({ kind: 'error', message: 'No console output has been recorded for this process yet.' }),
      });
      manager.requestAgentLog(7, 'review');
      expect(posts(7)).toContainEqual({
        type: 'agent-log',
        processId: 'review',
        result: { kind: 'error', message: 'No console output has been recorded for this process yet.' },
      });
    });

    it('degrades agent-log to a named refusal when no reader is configured', () => {
      const { manager, posts } = makeHarness({});
      manager.requestAgentLog(7, 'tester');
      expect(posts(7)).toContainEqual({
        type: 'agent-log',
        processId: 'tester',
        result: { kind: 'error', message: 'No console log source is configured.' },
      });
    });

    it('posts a live agent-output chunk only to an OPEN panel', () => {
      const { manager, posts } = makeHarness({});
      manager.postAgentOutput(7, 'tester', 'live chunk');
      expect(posts(7)).toContainEqual({ type: 'agent-output', processId: 'tester', text: 'live chunk' });
      expect(() => manager.postAgentOutput(999, 'tester', 'x')).not.toThrow();
      expect(posts(999)).toEqual([]);
    });

    it('posts a live stage-output chunk only to an OPEN panel', () => {
      const { manager, posts } = makeHarness({});
      manager.postStageOutput(7, 'uat', 'gate chatter');
      expect(posts(7)).toContainEqual({ type: 'stage-output', stage: 'uat', text: 'gate chatter' });
      expect(() => manager.postStageOutput(999, 'uat', 'x')).not.toThrow();
      expect(posts(999)).toEqual([]);
    });

    it('posts a reader error result verbatim (UI-R13: the answer is the outcome)', () => {
      const { manager, posts } = makeHarness({
        stageLogReader: () => ({ kind: 'error', message: 'The recorded log file is no longer available.' }),
      });
      manager.requestStageLog(7, 'review');
      expect(posts(7)).toContainEqual({
        type: 'stage-log',
        stage: 'review',
        result: { kind: 'error', message: 'The recorded log file is no longer available.' },
      });
    });

    it('is a no-op for a ticket with no open panel, and never throws', () => {
      const { manager, posts } = makeHarness({
        stageLogReader: () => ({ kind: 'ok', content: 'x', truncated: false }),
      });
      expect(() => manager.requestStageLog(999, 'uat')).not.toThrow();
      expect(posts(999)).toEqual([]);
    });

    it('degrades to a named refusal when no reader is configured', () => {
      const { manager, posts } = makeHarness({});
      manager.requestStageLog(7, 'uat');
      expect(posts(7)).toContainEqual({
        type: 'stage-log',
        stage: 'uat',
        result: { kind: 'error', message: 'No console log source is configured.' },
      });
    });
  });

  describe('round switcher selection (Option B, T5)', () => {
    /**
     * Two full UAT rounds plus the live attempt (mirrors state.test.ts's own
     * `seedTwoRoundUatHistory`) — enough attempts for a tab selection to have
     * somewhere to land, and for "stale key" to mean something.
     */
    function seedTwoRoundUatHistory(store: Store): { ticketId: number; stageRunIds: [number, number, number] } {
      const t = createTicket(store, { key: 'RS-1', title: 'round switcher' });
      store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
      setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-20T09:00:00.000Z' });

      const sr1 = openStageRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 0,
        runAt: '2026-08-20T09:00:00.000Z', startedAt: '2026-08-20T09:00:00.000Z',
      });
      recordGateRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 0, runAt: '2026-08-20T09:00:00.000Z', stageRunId: sr1,
        gates: [{ gateName: 'test (web)', exitCode: 1, startedAt: '2026-08-20T09:00:00.000Z', endedAt: '2026-08-20T09:01:00.000Z' }],
      });
      openRecoveryRound(store, {
        ticketId: t.id, sourceStage: 'uat', sourceProcessId: 'gates', sourceStageRunId: sr1,
        sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 'test (web) failed',
        maxRounds: 3, startedAt: '2026-08-20T09:01:00.000Z',
      });

      const sr2 = openStageRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 1,
        runAt: '2026-08-20T10:00:00.000Z', startedAt: '2026-08-20T10:00:00.000Z',
      });
      recordGateRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 1, runAt: '2026-08-20T10:00:00.000Z', stageRunId: sr2,
        gates: [{ gateName: 'test (web)', exitCode: 1, startedAt: '2026-08-20T10:00:00.000Z', endedAt: '2026-08-20T10:01:00.000Z' }],
      });
      openRecoveryRound(store, {
        ticketId: t.id, sourceStage: 'uat', sourceProcessId: 'gates', sourceStageRunId: sr2,
        sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 'test (web) failed again',
        maxRounds: 3, startedAt: '2026-08-20T10:01:00.000Z',
      });

      const sr3 = openStageRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 2,
        runAt: '2026-08-20T11:00:00.000Z', startedAt: '2026-08-20T11:00:00.000Z',
      });
      recordGateRun(store, {
        ticketId: t.id, stageKey: 'uat', attempt: 2, runAt: '2026-08-20T11:00:00.000Z', stageRunId: sr3,
        gates: [{ gateName: 'test (web)', exitCode: 0, startedAt: '2026-08-20T11:00:00.000Z', endedAt: '2026-08-20T11:01:00.000Z' }],
      });
      openProcessRun(store, {
        ticketId: t.id, stageKey: 'uat', processId: 'tester', attempt: 2, stageRunId: sr3,
        provider: 'codex', startedAt: '2026-08-20T11:02:00.000Z',
      });

      return { ticketId: t.id, stageRunIds: [sr1, sr2, sr3] };
    }

    function lastState(panel: FakePanel): any {
      return (panel.posted.filter((m: any) => m.type === 'state').at(-1) as any).state;
    }

    it('records a selection posted from the webview and reaches the state builder', () => {
      const { ticketId, stageRunIds } = seedTwoRoundUatHistory(store);
      const requested = attemptKey(stageRunIds[0], '');
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(ticketId);
      // Before any selection, the default is the latest attempt.
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(attemptKey(stageRunIds[2], ''));

      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'uat', key: requested });

      const uat = lastState(panels[0]!).insideViews.uat;
      expect(uat.selectedAttempt).toBe(requested);
      expect(uat.attemptNote).toBe('viewing round 1 — not the current result');
    });

    it('survives a subsequent snapshot/re-render (e.g. the live tick)', () => {
      const { ticketId, stageRunIds } = seedTwoRoundUatHistory(store);
      const requested = attemptKey(stageRunIds[0], '');
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(ticketId);
      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'uat', key: requested });

      // A later, unrelated snapshot push (a passive re-render) must still
      // reflect the earlier selection — it is host-held panel state, not a
      // one-shot response to the message that set it.
      mgr.pushPassiveState(ticketId);

      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(requested);
    });

    it('resets the selection when the panel opens a different ticket', () => {
      const { ticketId: ticketA, stageRunIds } = seedTwoRoundUatHistory(store);
      const ticketB = createTicket(store, { key: 'RS-2', title: 'other ticket' });
      const requested = attemptKey(stageRunIds[0], '');
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(ticketA);
      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'uat', key: requested });
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(requested);

      // Opening a DIFFERENT ticket's panel must not carry ticket A's selection
      // into ticket B's rendering — a selection scoped to one ticket must
      // never leak into another.
      mgr.openDashboard(ticketB.id);
      const uatB = lastState(panels[1]!).insideViews.uat;
      expect(uatB.selectedAttempt).toBeUndefined();

      // Re-opening (revealing) ticket A's still-open panel does not re-push,
      // but confirm its own selection is untouched by the other ticket's open.
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(requested);
    });

    it('leaves state unchanged for an unhandled or invalid message', () => {
      const { ticketId, stageRunIds } = seedTwoRoundUatHistory(store);
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(ticketId);
      const before = lastState(panels[0]!).insideViews.uat.selectedAttempt;
      const postCountBefore = panels[0]!.posted.length;

      // Missing `key`.
      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'uat' });
      // Invalid `stage`.
      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'bogus', key: 'x' });
      // Unrelated message type entirely.
      panels[0]!.emit({ type: 'not-a-real-message' });

      expect(panels[0]!.posted.length).toBe(postCountBefore);
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(before);
      void stageRunIds;
    });

    it('drops a selection whose key no longer exists in a new snapshot, falling back to latest', () => {
      const { ticketId, stageRunIds } = seedTwoRoundUatHistory(store);
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(ticketId);
      // Select a key that names no recorded attempt at all.
      panels[0]!.emit({ type: 'select-gate-attempt', stage: 'uat', key: 'sr:999999' });
      // The state builder degrades silently to latest for a stale key.
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(attemptKey(stageRunIds[2], ''));

      // A later push must still resolve to latest — the panel must not keep
      // re-requesting a key that never matched anything.
      mgr.pushPassiveState(ticketId);
      expect(lastState(panels[0]!).insideViews.uat.selectedAttempt).toBe(attemptKey(stageRunIds[2], ''));
    });
  });

  it('routes server-logs-detach to the injected callback bound to its ticket', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const detached: number[] = [];
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      (ticketId) => detached.push(ticketId),
    );

    mgr.openDashboard(t.id);
    panels[0]!.emit({ type: 'server-logs-detach' });

    expect(detached).toEqual([t.id]);
  });
});
