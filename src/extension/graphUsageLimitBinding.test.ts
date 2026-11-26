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
import type { RecoveryRefusalReason } from '../approaches/graph/coordinator/recovery.js';
import type { GraphRecoverySeams } from './ops/graphRecoveryDispatch.js';
import type { AccountsConfig } from '../agent/accounts/types.js';
import { PICK_LABEL, PICK_ACCOUNT_LABEL, RETRY_LABEL, DISMISS_LABEL } from './ops/interactiveUsageLimitActions.js';
import type { SupervisedAgentSession } from '../approaches/graph/transport/agentTransport.js';
import * as vscode from 'vscode';
import {
  createGraphUsageLimitBinding,
  graphAccountActivity,
  graphAccountRefusalNotice,
  parkedGraphRole,
  type GraphUsageLimitBindingDeps,
  type GraphUsageLimitSignal,
  type GraphUsageLimitTransport,
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

function plannerFixture(): Fixture {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at, agent_identity)
         VALUES (?, 'impl', 0, 'graph', 'planning', 1, ?, ?)`,
      )
      .run(ticketId, NOW, JSON.stringify(ROLES)).lastInsertRowid,
  );
  const processRunId = openProcessRun(store, {
    ticketId,
    stageKey: 'impl',
    processId: 'graph-planner',
    attempt: 0,
    agentName: 'fast',
    provider: 'claude',
    model: 'claude-haiku-4',
    startedAt: NOW,
  }).id;
  const plannerRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, planner_run_number, kind, status, process_run_id, profile, provider, model)
         VALUES (?, 1, 'bootstrap', 'running', ?, 'fast', 'claude', 'claude-haiku-4')`,
      )
      .run(graphRunId, processRunId).lastInsertRowid,
  );
  return { graphRunId, nodeRunId: plannerRunId };
}

/** A second running node of the same graph run (parallel nodes). */
function addNodeRun(fixture: Fixture): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, profile, provider, model)
         VALUES (?, (SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? LIMIT 1),
                 'n2', 'agent', 1, 'running', 'worker', 'claude', 'claude-sonnet-4-5')`,
      )
      .run(fixture.graphRunId, fixture.graphRunId).lastInsertRowid,
  );
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
  debug: ReturnType<typeof vi.fn>;
  toastError: ReturnType<typeof vi.fn>;
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
  const debug = vi.fn();
  const toastError = vi.fn();
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
    graphConfigOf: () => ({ limits: { maxReplans: 3 } }) as GraphApproachConfig,
    ticketLaunchFieldsOf: () => ({}) as GraphLaunchTicketFields,
    refresh,
    debug,
    logError,
    ask,
    toastError,
    ...over,
  };
  return { deps, ask, pick, terminate, recover, refresh, logError, debug, toastError };
}

/** Replace the sessions the transport reports (the park itself still runs). */
function withSessions(h: Harness, sessions: readonly SupervisedAgentSession[]): Harness {
  h.deps.transport = () => ({
    sessions: () => sessions,
    terminate: h.terminate as unknown as GraphUsageLimitTransport['terminate'],
  });
  return h;
}

/** The machine-local accounts: `default` plus the stored `work` account. */
const ACCOUNTS: AccountsConfig = {
  claude: {
    active: 'default',
    list: { work: { kind: 'subscription', source: 'folder', dir: '/accounts/work' } },
  },
};

/**
 * The account seams of the graph park. `names` is the list the parked core
 * shows (`default` first); `picked` is the QuickPick answer (undefined = the
 * user closed it).
 */
function withAccounts(h: Harness, names: readonly string[], picked?: string, active = names[0]): Harness {
  h.deps.accountsOf = vi.fn(async () => names.map((name) => ({ name, active: name === active })));
  h.deps.accountStatus = vi.fn(async () => 'signed-in' as const);
  h.deps.accountsConfig = () => ACCOUNTS;
  h.deps.pickAccount = vi.fn(async () => picked);
  return h;
}

/** Recovery seams whose Resume is refused (the guidance must surface). */
function refusedSeams(reason: RecoveryRefusalReason = 'launch-loop'): GraphRecoverySeams {
  return {
    recover: vi.fn(() => ({ kind: 'refused', reason })),
    launchReplan: vi.fn(),
    launchBootstrap: vi.fn(),
    onRecovered: vi.fn(),
  } as unknown as GraphRecoverySeams;
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

  it('offers no Pick account when the parked core has one account', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [DISMISS_LABEL]), ['default']);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledWith(
      'Graph node of GP-1 hit the claude usage limit',
      PICK_LABEL,
      RETRY_LABEL,
      DISMISS_LABEL,
    );
    expect(h.deps.pickAccount).not.toHaveBeenCalled();
  });

  it('Pick account pins ONLY the parked role account, then resumes, in that order', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work'], 'work');
    const activity = vi.fn();
    h.deps.activity = activity;
    // The resume must see the pinned account: proving the switch ran first.
    const atResume: Array<string | undefined> = [];
    h.recover.mockImplementation(() => {
      const snapshot = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
      atResume.push(snapshot.roles.worker.account);
      return { kind: 'no-op' as const };
    });

    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenCalledWith(
      'Graph node of GP-1 hit the claude usage limit',
      PICK_LABEL,
      PICK_ACCOUNT_LABEL,
      RETRY_LABEL,
      DISMISS_LABEL,
    );
    expect(h.deps.pickAccount).toHaveBeenCalledWith('claude', [
      { name: 'default', current: true, status: 'signed-in' },
      { name: 'work', current: false, status: 'signed-in' },
    ]);
    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles).toEqual({
      expert: { provider: 'claude', model: 'claude-opus-5-5', source: 'approach' },
      worker: {
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        source: 'approach',
        account: 'work',
      },
      fast: { provider: 'claude', model: 'claude-haiku-4', source: 'approach' },
    });
    expect(atResume).toEqual(['work']);
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
    expect(activity).toHaveBeenCalledWith(
      ticketId,
      'graph worker runs under account work (picked at the usage limit)',
    );
  });

  it('marks the pinned account of the parked role as the current one', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare('UPDATE approach_graph_runs SET agent_identity = ? WHERE id = ?')
      .run(
        JSON.stringify({
          v: 1,
          roles: { ...ROLES.roles, worker: { ...ROLES.roles.worker, account: 'work' } },
        }),
        fixture.graphRunId,
      );
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work'], 'work');
    // No probe wired: the rows still list, with an unknown state.
    h.deps.accountStatus = undefined;
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.deps.pickAccount).toHaveBeenCalledWith('claude', [
      { name: 'default', current: false, status: 'unknown' },
      { name: 'work', current: true, status: 'unknown' },
    ]);
  });

  it('a pick of default removes the pin and the Activity names the active account that runs', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare('UPDATE approach_graph_runs SET agent_identity = ? WHERE id = ?')
      .run(
        JSON.stringify({
          v: 1,
          roles: { ...ROLES.roles, worker: { ...ROLES.roles.worker, account: 'home' } },
        }),
        fixture.graphRunId,
      );
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work', 'home'], 'default', 'work');
    h.deps.accountsConfig = () => ({
      claude: {
        active: 'work',
        list: {
          work: { kind: 'subscription', source: 'folder', dir: '/accounts/work' },
          home: { kind: 'subscription', source: 'folder', dir: '/accounts/home' },
        },
      },
    });
    const activity = vi.fn();
    h.deps.activity = activity;
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles.worker).not.toHaveProperty('account');
    expect(activity).toHaveBeenCalledWith(
      ticketId,
      'graph worker runs under the active account work (picked default at the usage limit)',
    );
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
  });

  for (const missing of ['accountsOf', 'pickAccount', 'accountsConfig'] as const) {
    it(`offers no Pick account when the ${missing} seam is not wired`, async () => {
      const fixture = nodeFixture();
      const h = withAccounts(harness(fixture, [DISMISS_LABEL]), ['default', 'work']);
      h.deps[missing] = undefined;
      await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

      expect(h.ask).toHaveBeenCalledWith(
        'Graph node of GP-1 hit the claude usage limit',
        PICK_LABEL,
        RETRY_LABEL,
        DISMISS_LABEL,
      );
    });
  }

  it('lists the accounts with none marked when no row is active and no account is pinned', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work'], 'work', 'none');
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.deps.pickAccount).toHaveBeenCalledWith('claude', [
      { name: 'default', current: false, status: 'signed-in' },
      { name: 'work', current: false, status: 'signed-in' },
    ]);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a pick with no Activity seam still pins the account and resumes', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work'], 'work');
    h.deps.activity = undefined;
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!).roles.worker.account).toBe('work');
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('an account pick after the store is gone writes nothing and does not resume', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL]), ['default', 'work'], 'work');
    let calls = 0;
    h.deps.store = () => (++calls === 1 ? store : undefined);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.deps.pickAccount).toHaveBeenCalledTimes(1);
    expect(graphRunAgentIdentity(store.db, fixture.graphRunId)).toBe(JSON.stringify(ROLES));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('offers no Pick account when the account list is unavailable', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [DISMISS_LABEL]), ['default', 'work']);
    h.deps.accountsOf = async () => undefined;
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledWith(
      'Graph node of GP-1 hit the claude usage limit',
      PICK_LABEL,
      RETRY_LABEL,
      DISMISS_LABEL,
    );
    expect(h.deps.pickAccount).not.toHaveBeenCalled();
  });

  it('a cancelled account picker asks again and writes nothing', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(harness(fixture, [PICK_ACCOUNT_LABEL, DISMISS_LABEL]), ['default', 'work']);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.deps.pickAccount).toHaveBeenCalledTimes(1);
    expect(graphRunAgentIdentity(store.db, fixture.graphRunId)).toBe(JSON.stringify(ROLES));
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('an account pick the switch refuses shows a notice and asks again', async () => {
    const fixture = nodeFixture();
    const h = withAccounts(
      harness(fixture, [PICK_ACCOUNT_LABEL, undefined, DISMISS_LABEL]),
      ['default', 'gone'],
      'gone',
    );
    h.deps.accountsConfig = () => ({ claude: { active: 'default', list: {} } });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.ask).toHaveBeenCalledWith(
      "Karst did not switch the graph worker of this run to the claude account 'gone': it is not a stored claude account.",
    );
    expect(h.debug).toHaveBeenCalledWith(
      `[graph] usage-limit: account "gone" not pinned for run ${fixture.graphRunId} role "worker" (unknown-account)`,
    );
    // The notice is not a question: two prompts still reached the user.
    expect(h.ask.mock.calls.filter((call) => call.length > 1)).toHaveLength(2);
    expect(graphRunAgentIdentity(store.db, fixture.graphRunId)).toBe(JSON.stringify(ROLES));
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('Retry same resumes without switching models', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [RETRY_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));

    expect(h.pick).not.toHaveBeenCalled();
    expect(graphRunAgentIdentity(store.db, fixture.graphRunId)).toBe(JSON.stringify(ROLES));
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
    // A no-op recovery is not a refusal: no second notice.
    expect(h.ask).toHaveBeenCalledTimes(1);
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
    // Only the finally refreshes: a lost park writes no stage block and no refresh.
    expect(h.refresh).toHaveBeenCalledTimes(1);
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

  it('refreshes once for the park and once in the finally', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.refresh).toHaveBeenNthCalledWith(1, ticketId);
    expect(h.refresh).toHaveBeenNthCalledWith(2, ticketId);
  });

  it('parks without terminating when the transport is not wired', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL], { transport: () => undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.debug).not.toHaveBeenCalledWith(expect.stringContaining('termination failed'));
    expect(runRow(fixture.graphRunId).status).toBe('blocked');
    expect(h.ask).toHaveBeenCalledTimes(1);
  });

  it('terminates no session when the transport reports none', async () => {
    const fixture = nodeFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), []);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.ask).toHaveBeenCalledTimes(1);
  });

  it('terminates no session whose graph run differs', async () => {
    const fixture = nodeFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      { ...sessionOf(fixture), graphRunId: 999 } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('terminates no session whose role run differs', async () => {
    const fixture = nodeFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      { ...sessionOf(fixture), nodeRunId: 999 } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('terminates no session whose role differs', async () => {
    const fixture = nodeFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      { ...sessionOf(fixture), runKind: 'planner' } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('terminates a node session that carries no runKind', async () => {
    const fixture = nodeFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      { ...sessionOf(fixture), runKind: undefined } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('parks a planner and switches the fast role the process run names', async () => {
    const fixture = plannerFixture();
    const h = withSessions(harness(fixture, [PICK_LABEL]), [
      { ...sessionOf(fixture), runKind: 'planner' } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit({
      ticketId,
      graphRunId: fixture.graphRunId,
      runId: fixture.nodeRunId,
      role: 'planner',
      provider: 'claude',
      text: QUOTA,
    });

    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles.fast).toEqual({ provider: 'codex', model: 'gpt-5', source: 'approach' });
    expect(identity.roles.expert).toEqual(ROLES.roles.expert);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.recover).toHaveBeenCalledWith({ ticketId, graphRunId: fixture.graphRunId, mode: 'resume' });
    expect(
      store.db.prepare('SELECT status FROM approach_planner_runs WHERE id = ?').get(fixture.nodeRunId),
    ).toEqual({ status: 'stale' });
  });

  it('a Pick with no manifest keeps the park and does not resume', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [PICK_LABEL], { manifest: () => undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
    expect(runRow(fixture.graphRunId).status).toBe('blocked');
  });

  it('a Pick whose graph run vanished does not resume', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [PICK_LABEL]);
    h.deps.pick = vi.fn(async () => {
      store.db.prepare('DELETE FROM approach_node_runs WHERE id = ?').run(fixture.nodeRunId);
      store.db.prepare('DELETE FROM approach_graph_revisions WHERE graph_run_id = ?').run(fixture.graphRunId);
      store.db.prepare('DELETE FROM approach_graph_runs WHERE id = ?').run(fixture.graphRunId);
      return { provider: 'codex' as const, model: 'gpt-5' };
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.ask).toHaveBeenCalledTimes(1);
  });

  it('a Pick with no readable snapshot does not resume', async () => {
    const fixture = nodeFixture();
    store.db.prepare('UPDATE approach_graph_runs SET agent_identity = NULL WHERE id = ?').run(fixture.graphRunId);
    const h = harness(fixture, [PICK_LABEL], { graphConfigOf: () => undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a Pick keeps an absent previous source as approach', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare('UPDATE approach_graph_runs SET agent_identity = ? WHERE id = ?')
      .run(
        JSON.stringify({ v: 1, roles: { expert: ROLES.roles.expert, fast: ROLES.roles.fast } }),
        fixture.graphRunId,
      );
    const h = harness(fixture, [PICK_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles.worker).toEqual({ provider: 'codex', model: 'gpt-5', source: 'approach' });
    expect(h.recover).toHaveBeenCalledTimes(1);
  });

  it('a Pick keeps a legacy ticket source', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare('UPDATE approach_graph_runs SET agent_identity = ? WHERE id = ?')
      .run(
        JSON.stringify({
          v: 1,
          roles: { ...ROLES.roles, worker: { provider: 'claude', model: 'claude-sonnet-4-5', source: 'ticket' } },
        }),
        fixture.graphRunId,
      );
    const h = harness(fixture, [PICK_LABEL]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    const identity = JSON.parse(graphRunAgentIdentity(store.db, fixture.graphRunId)!);
    expect(identity.roles.worker).toEqual({ provider: 'codex', model: 'gpt-5', source: 'ticket' });
    expect(h.recover).toHaveBeenCalledTimes(1);
  });

  it('a Pick that changes nothing asks again', async () => {
    const fixture = nodeFixture();
    store.db
      .prepare('UPDATE approach_graph_runs SET agent_identity = ? WHERE id = ?')
      .run(
        JSON.stringify({
          v: 1,
          roles: { ...ROLES.roles, worker: { provider: 'claude', model: 'claude-sonnet-4-5', source: 'approach' } },
        }),
        fixture.graphRunId,
      );
    const h = harness(fixture, [PICK_LABEL, DISMISS_LABEL], {
      pick: vi.fn(async () => ({ provider: 'claude' as const, model: 'claude-sonnet-4-5' })),
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it('Resume with no recovery seams logs and does not resume', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [RETRY_LABEL], { recovery: () => undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.debug).toHaveBeenCalledWith(
      `[graph] usage-limit: recovery seams not wired, run ${fixture.graphRunId} stays blocked`,
    );
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a Pick with no store after the park does nothing', async () => {
    const fixture = nodeFixture();
    let calls = 0;
    const h = harness(fixture, [PICK_LABEL], { store: () => (++calls === 1 ? store : undefined) });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('does nothing and logs when the coordinator store is not wired', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [], { store: () => undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.debug).toHaveBeenCalledWith('[graph] usage-limit: coordinator store is not wired, nothing parked');
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('parks nothing when the role run has no identity and no provider', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, []);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit({
      ...signal(fixture),
      runId: 999_999,
      provider: null,
    });
    expect(h.debug).toHaveBeenCalledWith(
      '[graph] usage-limit: node run 999999 has no running process identity, nothing parked',
    );
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('reads no identity model when the role run is gone but the provider is known', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, []);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit({ ...signal(fixture), runId: 999_999 });
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a park failure logs, toasts and still refreshes', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [], {
      transaction: () => {
        throw new Error('db gone');
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.logError).toHaveBeenCalledWith('karst: graph usage-limit park failed', expect.any(Error));
    expect(h.toastError).toHaveBeenCalledWith(
      'Karst could not park the graph node on its usage limit (db gone).',
    );
    expect(h.refresh).toHaveBeenCalledWith(ticketId);
    expect(h.ask).not.toHaveBeenCalled();
  });

  it('uses the VS Code warning prompt when no prompt seam is injected', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL], { ask: undefined });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Graph node of GP-1 hit the claude usage limit',
      PICK_LABEL,
      RETRY_LABEL,
      DISMISS_LABEL,
    );
  });

  it('uses the VS Code error toast when no toast seam is injected', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [], {
      toastError: undefined,
      transaction: () => {
        throw new Error('db gone');
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Karst could not park the graph node on its usage limit (db gone).',
    );
  });

  it('terminates a re-attached planner session that omits its runKind', async () => {
    const fixture = plannerFixture();
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      { ...sessionOf(fixture), runKind: undefined } as unknown as SupervisedAgentSession,
    ]);
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit({
      ticketId,
      graphRunId: fixture.graphRunId,
      runId: fixture.nodeRunId,
      role: 'planner',
      provider: 'claude',
      text: QUOTA,
    });
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it('parks a parallel node without a second prompt', async () => {
    const fixture = nodeFixture();
    store.db.prepare('UPDATE approach_graph_runs SET active_processes = 2 WHERE id = ?').run(fixture.graphRunId);
    const second = addNodeRun(fixture);
    const h = withSessions(harness(fixture, [DISMISS_LABEL]), [
      sessionOf(fixture),
      { ...sessionOf(fixture), nodeRunId: second } as unknown as SupervisedAgentSession,
    ]);
    const binding = createGraphUsageLimitBinding(h.deps);
    await binding.onGraphUsageLimit(signal(fixture));
    await binding.onGraphUsageLimit({ ...signal(fixture), runId: second, text: 'limit two' });

    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(nodeRow(second)).toMatchObject({ status: 'blocked', failure_category: 'usage-limit' });
    expect(h.terminate).toHaveBeenCalledTimes(2);
  });

  it('a failed post-commit stage write never drops the prompt or reports a park failure', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        throw new Error('clock gone');
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.debug).toHaveBeenCalledWith(
      '[graph] usage-limit: stage block after the park failed (clock gone); the run stays blocked',
    );
  });

  it('retries a stage write whose error only names the lock in its message', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        if (nowCalls === 2) throw new Error('database is busy');
        return NOW;
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenCalledTimes(1);
  });

  it('retries a snapshot lock code that only starts with SQLITE_BUSY', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        if (nowCalls === 2) throw Object.assign(new Error('snapshot'), { code: 'SQLITE_BUSY_SNAPSHOT' });
        return NOW;
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenCalledTimes(1);
  });

  it('does not retry another SQLite code', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        throw Object.assign(new Error('nope'), { code: 'SQLITE_CORRUPT' });
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).not.toHaveBeenCalled();
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('does not treat a non-Error throw as lock contention', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        throw { code: 'SQLITE_BUSY' };
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).not.toHaveBeenCalled();
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('the default pause waits before retrying a lock-contended stage write', async () => {
    vi.useFakeTimers();
    try {
      const fixture = nodeFixture();
      let nowCalls = 0;
      const h = harness(fixture, [DISMISS_LABEL], {
        now: () => {
          nowCalls += 1;
          if (nowCalls === 1) return NOW;
          if (nowCalls === 2) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
          return NOW;
        },
      });
      let settled = false;
      const pending = createGraphUsageLimitBinding(h.deps)
        .onGraphUsageLimit(signal(fixture))
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(settled).toBe(true);
      expect(h.ask).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a lock-contended stage write and then offers the prompt', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        if (nowCalls < 4) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
        return NOW;
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).toHaveBeenCalledTimes(2);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(stageBlock(store, ticketId, 'impl')?.reason).toContain('usage-limit:');
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('gives up the stage write after the bounded retries and still prompts', async () => {
    const fixture = nodeFixture();
    let nowCalls = 0;
    const pause = vi.fn(async () => undefined);
    const h = harness(fixture, [DISMISS_LABEL], {
      pause,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) return NOW;
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      },
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(pause).toHaveBeenCalledTimes(5);
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.debug).toHaveBeenCalledWith(expect.stringContaining('stage block after the park failed'));
  });

  it('a failed refresh never reports a park failure', async () => {
    const fixture = nodeFixture();
    const refresh = vi.fn(() => {
      throw new Error('dashboard gone');
    });
    const h = harness(fixture, [DISMISS_LABEL], { refresh });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.debug).toHaveBeenCalledWith('[graph] usage-limit: refresh after the park failed: dashboard gone');
  });

  it('shows the refusal guidance when Retry same is refused', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [RETRY_LABEL], { recovery: () => refusedSeams() });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.ask).toHaveBeenLastCalledWith(expect.stringContaining('cannot resume itself (launch-loop)'));
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('shows the refusal guidance when a Pick then Resume is refused', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [PICK_LABEL], { recovery: () => refusedSeams('explicit-resolution') });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(h.ask).toHaveBeenLastCalledWith(
      expect.stringContaining('cannot resume itself (explicit-resolution)'),
    );
  });

  it('a refused Resume with no store shows no notice', async () => {
    const fixture = nodeFixture();
    let calls = 0;
    const h = harness(fixture, [RETRY_LABEL], {
      recovery: () => refusedSeams(),
      store: () => (++calls === 1 ? store : undefined),
    });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenCalledTimes(1); // only the prompt
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('a refusal notice falls back to the default cap when the run is gone', async () => {
    const fixture = nodeFixture();
    const seams = refusedSeams();
    (seams.recover as ReturnType<typeof vi.fn>).mockImplementation(() => {
      store.db.prepare('DELETE FROM approach_node_runs WHERE id = ?').run(fixture.nodeRunId);
      store.db.prepare('DELETE FROM approach_graph_revisions WHERE graph_run_id = ?').run(fixture.graphRunId);
      store.db.prepare('DELETE FROM approach_graph_runs WHERE id = ?').run(fixture.graphRunId);
      return { kind: 'refused', reason: 'launch-loop' };
    });
    const h = harness(fixture, [RETRY_LABEL], { recovery: () => seams });
    await createGraphUsageLimitBinding(h.deps).onGraphUsageLimit(signal(fixture));
    expect(h.ask).toHaveBeenLastCalledWith(expect.stringContaining('cannot resume itself (launch-loop)'));
  });

  it('the hook entry parks through the same signal', async () => {
    const fixture = nodeFixture();
    const h = harness(fixture, [DISMISS_LABEL]);
    createGraphUsageLimitBinding(h.deps).onGraphHookUsageLimit(
      {
        ticketId,
        graphRunId: fixture.graphRunId,
        runId: fixture.nodeRunId,
        role: 'node',
        provider: 'claude',
      },
      QUOTA,
    );
    await vi.waitFor(() => expect(h.ask).toHaveBeenCalledTimes(1));
    expect(nodeRow(fixture.nodeRunId)).toEqual({ status: 'blocked', failure_category: 'usage-limit' });
  });
});

describe('parkedGraphRole (T1380)', () => {
  it('returns the agent name when it is a graph role', () => {
    expect(parkedGraphRole('planner', 'fast')).toBe('fast');
  });

  it('falls back to expert for a planner with no usable agent name', () => {
    expect(parkedGraphRole('planner', 'bogus')).toBe('expert');
    expect(parkedGraphRole('planner', null)).toBe('expert');
  });

  it('falls back to worker for a node with no agent name', () => {
    expect(parkedGraphRole('node', null)).toBe('worker');
  });
});

describe('graphAccountRefusalNotice', () => {
  const head = "Karst did not switch the graph expert of this run to the codex account 'work': ";
  it.each([
    ['unknown-account', 'it is not a stored codex account.'],
    ['no-snapshot', 'the graph run has no identity snapshot.'],
    ['role-missing', 'the expert role is not in the run snapshot.'],
    ['not-found', 'the graph run no longer exists.'],
  ] as const)('names the cause of %s', (outcome, cause) => {
    expect(graphAccountRefusalNotice('codex', 'expert', 'work', outcome)).toBe(head + cause);
  });
});

describe('graphAccountActivity', () => {
  it('names the active account when default is picked while another account is active', () => {
    expect(graphAccountActivity('worker', 'default', 'work')).toBe(
      'graph worker runs under the active account work (picked default at the usage limit)',
    );
  });

  it.each([
    ['default', 'default', 'graph worker runs under account default (picked at the usage limit)'],
    ['default', undefined, 'graph worker runs under account default (picked at the usage limit)'],
    ['home', 'work', 'graph worker runs under account home (picked at the usage limit)'],
    ['home', undefined, 'graph worker runs under account home (picked at the usage limit)'],
  ] as const)('names the picked account %s when the active account is %s', (chosen, active, text) => {
    expect(graphAccountActivity('worker', chosen, active)).toBe(text);
  });
});
