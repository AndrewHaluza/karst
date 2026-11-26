/**
 * T1370 — hook events of a graph planner or node session. A graph session
 * admits ONLY `UsageUpdate`: its spend reaches the ledger, bound to the running
 * graph process run, and every other event leaves the ticket state alone.
 *
 * Kept beside `dispatch.test.ts` (2,000+ lines) as its own file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, setAgentState, setSessionId } from '../store/tickets.js';
import { openProcessRun } from '../store/processRuns.js';
import { createHookChannelRecorder } from '../diagnostics/hookChannel.js';
import { graphLaunchId } from '../approaches/graph/graphLaunchId.js';
import { dispatchHook, TurnTracker, type HookPayload } from './dispatch.js';

const T0 = '2026-11-26T10:00:00.000Z';
const WT = '/repo/.karst/worktrees/x';
const WS = '/data/graph/7/workspaces/31/app';
const GEN = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';
const OTHER_GEN = '019ab3c2-0000-7e4f-8a2b-3c4d5e6f7a8b';
const PLANNER_LAUNCH = graphLaunchId({ graphRunId: 7, runId: 4, role: 'planner', generation: GEN });
const NODE_LAUNCH = graphLaunchId({ graphRunId: 7, runId: 31, role: 'node', generation: GEN });
const QUOTA = "You've hit your 5-hour limit · resets 4:10am";

let store: Store;
let ticketId: number;

function usage(eventId: string, input = 1_000, output = 100): Record<string, number | string> {
  return { event_id: eventId, input, output };
}

function processRun(provider: string, processId: string): number {
  return openProcessRun(store, {
    ticketId,
    stageKey: 'impl',
    processId,
    attempt: 1,
    provider,
    model: 'm',
    startedAt: T0,
  }).id;
}

/** A ticket at WT with an open graph run, a running claude planner (4) and a
 *  running opencode2 node (31) whose workspace is WS. */
function seedGraph(): void {
  ticketId = createTicket(store, { key: 'G', title: 'graph' }).id;
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
    )
    .run(ticketId, WT);
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs
         (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (7, ?, 'impl', 1, 'graph', 'running', ?)`,
    )
    .run(ticketId, T0);
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions
         (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (1, 7, 1, 'graph: []', 'fp', 'active', ?)`,
    )
    .run(T0);
  store.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status, process_run_id,
          profile, provider, model, generation)
       VALUES (4, 7, 1, 'bootstrap', 'running', ?, 'planner', 'claude', 'm', ?)`,
    )
    .run(processRun('claude', 'graph-planner'), GEN);
  store.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number,
          status, process_run_id, profile, provider, model, generation)
       VALUES (31, 7, 1, 'n1', 'agent', 1, 'running', ?, 'worker', 'opencode2', 'm', ?)`,
    )
    .run(processRun('opencode2', 'graph-node'), GEN);
  store.db
    .prepare(
      `INSERT INTO approach_graph_workspaces
         (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (7, 31, 'app', ?, 10, ?)`,
    )
    .run(WS, T0);
}

function ledger(): Array<Record<string, unknown>> {
  return store.db
    .prepare(
      `SELECT provider, approach_planner_run_id, approach_node_run_id, input_tokens
         FROM token_usage ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  store = openStore(':memory:');
  seedGraph();
});
afterEach(() => store.close());

describe('dispatchHook — graph node workspace (T1370)', () => {
  it('records a UsageUpdate from a node workspace cwd against the node run', () => {
    const notify = vi.fn();
    const recorder = createHookChannelRecorder();
    const result = dispatchHook(
      store,
      { hook_event_name: 'UsageUpdate', cwd: WS, session_id: 'oc-1', usage: usage('e1') },
      notify,
      undefined,
      undefined,
      recorder,
    );
    expect(result).toEqual({ admitted: true, ticketId });
    expect(ledger()).toEqual([
      { provider: 'opencode2', approach_planner_run_id: null, approach_node_run_id: 31, input_tokens: 1_000 },
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().outcomes).toEqual({ 'graph-usage': 1 });
  });

  it('also records the node usage when the payload carries the node launch id', () => {
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WS,
      session_id: 'oc-1',
      launchId: NODE_LAUNCH,
      usage: usage('e1'),
    });
    expect(ledger()).toMatchObject([{ approach_node_run_id: 31 }]);
  });

  it('does not notify views when the usage sample changed no spend', () => {
    const notify = vi.fn();
    const payload: HookPayload = { hook_event_name: 'UsageUpdate', cwd: WS, session_id: 'oc-1', usage: usage('e1') };
    dispatchHook(store, payload, notify);
    dispatchHook(store, payload, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger()).toHaveLength(1);
  });

  it.each(['Stop', 'SessionStart', 'session.idle', 'PostToolUse', 'UserPromptSubmit', 'SessionEnd'])(
    'a %s from the node workspace changes no ticket state',
    (event) => {
      setAgentState(store, ticketId, 'idle');
      setSessionId(store, ticketId, 'ticket-sess', 'claude');
      const notify = vi.fn();
      const tracker = new TurnTracker();
      const recorder = createHookChannelRecorder();
      const result = dispatchHook(
        store,
        { hook_event_name: event, cwd: WS, session_id: 'oc-1', tool_name: 'bash' },
        notify,
        () => true,
        () => 'claude',
        recorder,
        undefined,
        tracker,
      );
      expect(result).toEqual({ admitted: false });
      const ticket = getTicket(store, ticketId);
      expect(ticket.agentState).toBe('idle');
      expect(ticket.sessionId).toBe('ticket-sess');
      expect(notify).not.toHaveBeenCalled();
      expect(tracker.toolCount(ticketId)).toBe(0);
      expect(ledger()).toEqual([]);
      expect(recorder.snapshot().outcomes).toEqual({ 'graph-ignored': 1 });
      const stamped = store.db
        .prepare('SELECT last_hook_at FROM tickets WHERE id = ?')
        .get(ticketId) as { last_hook_at: string | null } | undefined;
      expect(stamped?.last_hook_at ?? null).toBeNull();
    },
  );

  it('records the node usage under the graph provider when the ticket provider differs', () => {
    setSessionId(store, ticketId, 'oc-1', 'codex');
    dispatchHook(
      store,
      { hook_event_name: 'UsageUpdate', cwd: WS, session_id: 'oc-1', usage: usage('e1') },
      undefined,
      () => true,
      () => 'codex',
    );
    expect(ledger()).toMatchObject([{ provider: 'opencode2', approach_node_run_id: 31 }]);
  });
});

describe('dispatchHook — parallel graph nodes (T1385)', () => {
  /** A second running opencode2 node (32) in the same graph run, newer than 31. */
  function seedParallelNode(): string {
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number,
            status, process_run_id, profile, provider, model, generation)
         VALUES (32, 7, 1, 'n2', 'agent', 1, 'running', ?, 'worker', 'opencode2', 'm', ?)`,
      )
      .run(processRun('opencode2', 'graph-node-32'), GEN);
    return graphLaunchId({ graphRunId: 7, runId: 32, role: 'node', generation: GEN });
  }

  it('files the usage of the older node under that node while a newer node of the same provider runs', () => {
    seedParallelNode();
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WS,
      session_id: 'oc-31',
      launchId: NODE_LAUNCH,
      usage: usage('e31'),
    });
    expect(ledger()).toMatchObject([{ approach_node_run_id: 31 }]);
    const nodeProcess = store.db
      .prepare('SELECT process_run_id FROM approach_node_runs WHERE id = 31')
      .get() as { process_run_id: number };
    expect(
      store.db.prepare('SELECT process_run_id FROM interactive_usage_samples').all(),
    ).toEqual([{ process_run_id: nodeProcess.process_run_id }]);
  });

  it('files each parallel node session under its own node run', () => {
    const second = seedParallelNode();
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      session_id: 'oc-32',
      launchId: second,
      usage: usage('e32'),
    });
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WS,
      session_id: 'oc-31',
      usage: usage('e31'),
    });
    expect(ledger()).toMatchObject([{ approach_node_run_id: 32 }, { approach_node_run_id: 31 }]);
  });
});

describe('dispatchHook — graph planner launch id (T1370)', () => {
  it('records a planner UsageUpdate from the ticket worktree, also when the generation check refuses it', () => {
    const shouldApply = vi.fn(() => false);
    const result = dispatchHook(
      store,
      {
        hook_event_name: 'UsageUpdate',
        cwd: WT,
        session_id: 'claude-uuid',
        launchId: PLANNER_LAUNCH,
        usage: usage('p1', 52_800, 5_000),
      },
      undefined,
      shouldApply,
      () => 'opencode2',
    );
    expect(result).toEqual({ admitted: true, ticketId });
    expect(shouldApply).not.toHaveBeenCalled();
    expect(ledger()).toEqual([
      { provider: 'claude', approach_planner_run_id: 4, approach_node_run_id: null, input_tokens: 52_800 },
    ]);
  });

  it('a SessionStart with the planner launch id changes no agent_state or session_id', () => {
    setAgentState(store, ticketId, 'idle');
    const notify = vi.fn();
    const result = dispatchHook(
      store,
      { hook_event_name: 'SessionStart', cwd: WT, session_id: 'claude-uuid', launchId: PLANNER_LAUNCH },
      notify,
      () => true,
      () => 'claude',
    );
    expect(result).toEqual({ admitted: false });
    const ticket = getTicket(store, ticketId);
    expect(ticket.agentState).toBe('idle');
    expect(ticket.sessionId).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('drops an event whose graph launch id names no open run, and never falls back to the ticket', () => {
    setAgentState(store, ticketId, 'idle');
    const recorder = createHookChannelRecorder();
    const unknown = graphLaunchId({ graphRunId: 7, runId: 99, role: 'planner', generation: GEN });
    for (const event of ['UsageUpdate', 'SessionStart']) {
      expect(
        dispatchHook(
          store,
          { hook_event_name: event, cwd: WT, session_id: 's', launchId: unknown, usage: usage('x') },
          undefined,
          () => true,
          () => 'claude',
          recorder,
        ),
      ).toEqual({ admitted: false });
    }
    expect(ledger()).toEqual([]);
    expect(getTicket(store, ticketId).agentState).toBe('idle');
    expect(getTicket(store, ticketId).sessionId).toBeNull();
    expect(recorder.snapshot().outcomes).toEqual({ 'graph-ignored': 2 });
  });

  it('drops a launch id whose generation is not the run generation, also from a node workspace cwd', () => {
    setAgentState(store, ticketId, 'idle');
    const recorder = createHookChannelRecorder();
    for (const launchId of [
      graphLaunchId({ graphRunId: 7, runId: 4, role: 'planner', generation: OTHER_GEN }),
      graphLaunchId({ graphRunId: 7, runId: 31, role: 'node', generation: OTHER_GEN }),
    ]) {
      // A node workspace cwd must not rescue a wrong generation.
      expect(
        dispatchHook(
          store,
          { hook_event_name: 'UsageUpdate', cwd: WS, session_id: 's', launchId, usage: usage('x') },
          undefined,
          () => true,
          () => 'claude',
          recorder,
        ),
      ).toEqual({ admitted: false });
    }
    expect(ledger()).toEqual([]);
    expect(getTicket(store, ticketId).agentState).toBe('idle');
    expect(recorder.snapshot().outcomes).toEqual({ 'graph-ignored': 2 });
  });

  it('a planner UsageUpdate with no session id records nothing', () => {
    const result = dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WT,
      launchId: PLANNER_LAUNCH,
      usage: usage('p1'),
    });
    expect(result).toEqual({ admitted: true, ticketId });
    expect(ledger()).toEqual([]);
  });

  it('a planner UsageUpdate with a malformed usage payload records nothing', () => {
    dispatchHook(store, {
      hook_event_name: 'UsageUpdate',
      cwd: WT,
      session_id: 'claude-uuid',
      launchId: PLANNER_LAUNCH,
      usage: { event_id: 'p1', input: -1, output: 'x' },
    });
    expect(ledger()).toEqual([]);
  });

  it('a planner UsageUpdate records nothing once the planner process run closed', () => {
    store.db.prepare("UPDATE process_runs SET status = 'passed' WHERE process_id = 'graph-planner'").run();
    const debug = vi.fn();
    dispatchHook(
      store,
      { hook_event_name: 'UsageUpdate', cwd: WT, session_id: 'claude-uuid', launchId: PLANNER_LAUNCH, usage: usage('p1') },
      undefined,
      undefined,
      undefined,
      undefined,
      debug,
    );
    expect(ledger()).toEqual([]);
    expect(debug.mock.calls.some(([m]) => String(m).includes('no running process'))).toBe(true);
  });

  it('a ticket UsageUpdate with no graph launch id still uses the ticket path', () => {
    setSessionId(store, ticketId, 'ticket-sess', 'claude');
    const shouldApply = vi.fn(() => true);
    const result = dispatchHook(
      store,
      { hook_event_name: 'UsageUpdate', cwd: WT, session_id: 'ticket-sess', usage: usage('t1') },
      undefined,
      shouldApply,
      () => 'claude',
    );
    expect(result).toEqual({ admitted: true, ticketId });
    expect(shouldApply).toHaveBeenCalledTimes(1);
  });

  it('a ticket SessionStart with no graph launch id still applies', () => {
    dispatchHook(store, { hook_event_name: 'SessionStart', cwd: WT, session_id: 'ticket-sess' }, undefined, () => true, () => 'claude');
    expect(getTicket(store, ticketId).agentState).toBe('running');
    expect(getTicket(store, ticketId).sessionId).toBe('ticket-sess');
  });
});

describe('dispatchHook — graph usage-limit session.error (T1380)', () => {
  it('reports a quota session.error of an owned node and writes no ticket state', () => {
    setAgentState(store, ticketId, 'idle');
    setSessionId(store, ticketId, 'ticket-sess', 'claude');
    const onGraphUsageLimit = vi.fn();
    const notify = vi.fn();
    const recorder = createHookChannelRecorder();
    const tracker = new TurnTracker();
    const result = dispatchHook(
      store,
      { hook_event_name: 'session.error', cwd: WS, session_id: 'oc-1', message: QUOTA },
      notify,
      () => true,
      () => 'claude',
      recorder,
      undefined,
      tracker,
      undefined,
      onGraphUsageLimit,
    );
    expect(result).toEqual({ admitted: false });
    expect(onGraphUsageLimit).toHaveBeenCalledTimes(1);
    expect(onGraphUsageLimit).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId, graphRunId: 7, runId: 31, role: 'node', provider: 'opencode2' }),
      QUOTA,
    );
    const ticket = getTicket(store, ticketId);
    expect(ticket.agentState).toBe('idle');
    expect(ticket.sessionId).toBe('ticket-sess');
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.toolCount(ticketId)).toBe(0);
    expect(ledger()).toEqual([]);
    expect(recorder.snapshot().outcomes).toEqual({ 'graph-ignored': 1 });
    const stamped = store.db
      .prepare('SELECT last_hook_at FROM tickets WHERE id = ?')
      .get(ticketId) as { last_hook_at: string | null } | undefined;
    expect(stamped?.last_hook_at ?? null).toBeNull();
  });

  it('reports a quota session.error of an owned planner launch', () => {
    const onGraphUsageLimit = vi.fn();
    dispatchHook(
      store,
      { hook_event_name: 'session.error', cwd: WT, session_id: 'claude-uuid', launchId: PLANNER_LAUNCH, message: QUOTA },
      undefined,
      () => true,
      () => 'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      onGraphUsageLimit,
    );
    expect(onGraphUsageLimit).toHaveBeenCalledTimes(1);
    expect(onGraphUsageLimit).toHaveBeenCalledWith(
      expect.objectContaining({ graphRunId: 7, runId: 4, role: 'planner', provider: 'claude' }),
      QUOTA,
    );
  });

  it('drops a non-quota session.error without reporting it', () => {
    const onGraphUsageLimit = vi.fn();
    for (const message of ['network timeout', 'Rate limit reached, retrying']) {
      const result = dispatchHook(
        store,
        { hook_event_name: 'session.error', cwd: WS, session_id: 'oc-1', message },
        undefined,
        () => true,
        () => 'claude',
        undefined,
        undefined,
        undefined,
        undefined,
        onGraphUsageLimit,
      );
      expect(result).toEqual({ admitted: false });
    }
    expect(onGraphUsageLimit).not.toHaveBeenCalled();
  });

  it('never reports an unowned graph session quota error', () => {
    const onGraphUsageLimit = vi.fn();
    const unknown = graphLaunchId({ graphRunId: 7, runId: 99, role: 'planner', generation: GEN });
    expect(
      dispatchHook(
        store,
        { hook_event_name: 'session.error', cwd: WT, session_id: 's', launchId: unknown, message: QUOTA },
        undefined,
        () => true,
        () => 'claude',
        undefined,
        undefined,
        undefined,
        undefined,
        onGraphUsageLimit,
      ),
    ).toEqual({ admitted: false });
    expect(onGraphUsageLimit).not.toHaveBeenCalled();
  });

  it('a throwing onGraphUsageLimit never breaks the hook path', () => {
    const debug = vi.fn();
    const result = dispatchHook(
      store,
      { hook_event_name: 'session.error', cwd: WS, session_id: 'oc-1', message: QUOTA },
      undefined,
      undefined,
      undefined,
      undefined,
      debug,
      undefined,
      undefined,
      () => {
        throw new Error('boom');
      },
    );
    expect(result).toEqual({ admitted: false });
    expect(debug.mock.calls.some(([m]) => String(m).includes('onGraphUsageLimit'))).toBe(true);
  });
});
