/**
 * T1380 — the host binding that parks a graph node/planner on its provider
 * usage limit, reports it on the stage, and offers the one-time prompt:
 * Pick agent/model… (role-scoped switch + Resume), Retry same (Resume), Dismiss.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { openProcessRun } from '../store/processRuns.js';
import { graphRunAgentIdentity } from '../store/graph/graphRuns.js';
import { stageBlock } from '../store/stageBlocks.js';
import { runImmediateTransaction } from '../store/transactions.js';
import type { GraphApproachConfig, Manifest } from '../manifest/types.js';
import type { GraphLaunchTicketFields } from '../approaches/graph/profileResolver.js';
import type { GraphRecoverySeams } from './ops/graphRecoveryDispatch.js';
import { PICK_LABEL, RETRY_LABEL, DISMISS_LABEL } from './ops/interactiveUsageLimitActions.js';
import type { SupervisedAgentSession } from '../approaches/graph/transport/agentTransport.js';
import {
  createGraphUsageLimitBinding,
  type GraphUsageLimitBindingDeps,
  type GraphUsageLimitSignal,
} from './graphUsageLimitBinding.js';

const NOW = '2026-11-26T10:00:00.000Z';
const QUOTA = "You've hit your 5-hour limit · resets 4:10am";
const ROLES = {
  v: 1,
  roles: {
    expert: { provider: 'claude', model: 'claude-opus-5-5', source: 'approach' },
    worker: { provider: 'claude', model: 'claude-sonnet-4-5', effort: 'high', source: 'approach' },
    fast: { provider: 'claude', model: 'claude-haiku-4', source: 'approach' },
  },
} as const;

let store: Store;
let ticketId: number;

beforeEach(() => {
  store = openStore(':memory:');
  const projectId = upsertProject(store, { slug: 'p' }).id;
  ticketId = createTicket(store, { key: 'GP-1', title: 'graph thing', projectId }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
  store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
});
afterEach(() => store.close());

interface Fixture {
  graphRunId: number;
  nodeRunId: number;
}

function nodeFixture(): Fixture {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at, agent_identity)
         VALUES (?, 'impl', 0, 'graph', 'running', 1, ?, ?)`,
      )
      .run(ticketId, NOW, JSON.stringify(ROLES)).lastInsertRowid,
  );
  const revisionId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW).lastInsertRowid,
  );
  const processRunId = openProcessRun(store, {
    ticketId,
    stageKey: 'impl',
    processId: 'graph-node',
    attempt: 0,
    agentName: 'worker',
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    startedAt: NOW,
  }).id;
  const nodeRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number,
            status, process_run_id, profile, provider, model)
         VALUES (?, ?, 'n', 'agent', 1, 'running', ?, 'worker', 'claude', 'claude-sonnet-4-5')`,
      )
      .run(graphRunId, revisionId, processRunId).lastInsertRowid,
  );
  return { graphRunId, nodeRunId };
}

function sessionOf(fixture: Fixture): SupervisedAgentSession {
  return {
    nodeRunId: fixture.nodeRunId,
    ticketId,
    graphRunId: fixture.graphRunId,
    runKind: 'node',
    pid: 123,
    cwd: '/ws',
    generation: 'g',
    ownerNonce: 'n',
    startedAt: NOW,
    processRunId: null,
    provider: 'claude',
    providerSessionId: null,
  } as unknown as SupervisedAgentSession;
}

interface Harness {
  deps: GraphUsageLimitBindingDeps;
  ask: ReturnType<typeof vi.fn>;
  pick: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  recover: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
}

function harness(
  fixture: Fixture,
  answers: Array<string | undefined>,
  over: Partial<GraphUsageLimitBindingDeps> = {},
): Harness {
  const queue = [...answers];
  const ask = vi.fn(async () => queue.shift());
  const pick = vi.fn(async () => ({ provider: 'codex' as const, model: 'gpt-5' }));
  const terminate = vi.fn(async () => ({ kind: 'dead' as const }));
  const recover = vi.fn(() => ({ kind: 'no-op' as const }));
  const refresh = vi.fn();
  const logError = vi.fn();
  const seams = {
    recover,
    launchReplan: vi.fn(),
    launchBootstrap: vi.fn(),
    onRecovered: vi.fn(),
  } as unknown as GraphRecoverySeams;
  const deps: GraphUsageLimitBindingDeps = {
    store: () => store,
    transaction: <T>(fn: () => T): T => runImmediateTransaction(store.db, fn),
    now: () => NOW,
    transport: () => ({ sessions: () => [sessionOf(fixture)], terminate }),
    recovery: () => seams,
    pick,
    manifest: () => ({}) as Manifest,
    graphConfigOf: () => ({}) as GraphApproachConfig,
    ticketLaunchFieldsOf: () => ({}) as GraphLaunchTicketFields,
    refresh,
    debug: () => undefined,
    logError,
    ask,
    toastError: () => undefined,
    ...over,
  };
  return { deps, ask, pick, terminate, recover, refresh, logError };
}

const signal = (fixture: Fixture): GraphUsageLimitSignal => ({
  ticketId,
  graphRunId: fixture.graphRunId,
  runId: fixture.nodeRunId,
  role: 'node',
  provider: 'claude',
  text: QUOTA,
});

function runRow(id: number): { status: string; blocked_reason: string | null; active_processes: number } {
  return store.db
    .prepare('SELECT status, blocked_reason, active_processes FROM approach_graph_runs WHERE id = ?')
    .get(id) as { status: string; blocked_reason: string | null; active_processes: number };
}

function nodeRow(id: number): { status: string; failure_category: string | null } {
  return store.db
    .prepare('SELECT status, failure_category FROM approach_node_runs WHERE id = ?')
    .get(id) as { status: string; failure_category: string | null };
}

describe('createGraphUsageLimitBinding (T1380)', () => {
  it('parks, blocks the stage, refreshes and prompts with the park text and actions', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(nodeRow(fixture.nodeRunId)).toEqual({ status: 'blocked', failure_category: 'usage-limit' });
    expect(runRow(fixture.graphRunId)).toMatchObject({ status: 'blocked', active_processes: 0 });
    expect(runRow(fixture.graphRunId).blocked_reason).toMatch(/^usage-limit: node run \d+ on claude\/claude-sonnet-4-5: /);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(stageBlock(store, ticketId, 'impl')?.reason).toContain('usage-limit:');
    expect(h.refresh).toHaveBeenCalledWith(ticketId);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenCalledWith(
      'Graph node of GP-1 hit the claude usage limit',
      PICK_LABEL,
      RETRY_LABEL,
      DISMISS_LABEL,
    );
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('Pick switches ONLY the parked role, then resumes the run', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [PICK_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.pick).toHaveBeenCalledWith('claude', 'claude-sonnet-4-5');
    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles).toEqual({
      expert: { provider: 'claude', model: 'claude-opus-5-5', source: 'approach' },
      worker: { provider: 'codex', model: 'gpt-5', source: 'approach' },
      fast: { provider: 'claude', model: 'claude-haiku-4', source: 'approach' },
    });
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
    expect(h.refresh).toHaveBeenCalledWith(ticketId);
  });

  it('a cancelled picker asks again', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [PICK_LABEL, DISMISS_LABEL], {
      pick: vi.fn(async () => undefined),
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('Retry same resumes without switching models', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [RETRY_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.pick).not.toHaveBeenCalled();
    expect(graphRunAgentIdentity(store.db, fixture.graphRunId)).toBe(JSON.stringify(ROLES));
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
  });

  it('Dismiss leaves the run blocked and never prompts again on a reload', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL]);
    const binding = createGraphUsageLimitBinding(h.deps);
    await binding.onGraphUsageLimit(signal(fixture));
    expect(runRow(fixture.graphRunId).status).toBe('blocked');
    expect(h.recover).not.toHaveBeenCalled();

    // A second signal (or a window reload) is a no-op: the park CAS loses, so
    // the prompt is never offered for an already-blocked run.
    const second = harness(fixture, []);
    const binding2 = createGraphUsageLimitBinding(second.deps);
    await binding2.onGraphUsageLimit(signal(fixture));
    expect(second.ask).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
  });

  it('does not prompt when the park loses its CAS', async () => {
    const fixture = nodeFixture();
    store.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(fixture.graphRunId);
    const h = harness(fixture, []);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('falls back to the worker role when the process identity has no agent name', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare("UPDATE approach_node_runs SET process_run_id = NULL WHERE id = ?")
      .run(fixture.nodeRunId);
    store.db.prepare("UPDATE approach_node_runs SET profile = NULL WHERE id = ?").run(fixture.nodeRunId);
    const h = harness(fixture, [PICK_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit({
      ...signal(fixture),
      provider: null,
    });
    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles.worker).toEqual({ provider: 'codex', model: 'gpt-5', source: 'approach' });
    // The provider falls back to the run row's own identity.
    expect(runRow(fixture.graphRunId).blocked_reason).toMatch(/on claude\//);
  });
});
