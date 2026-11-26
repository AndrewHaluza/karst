/**
 * T1385 — the first-activity watchdog: a running opencode2 node (or a claude
 * node on host placement) with no usage sample after 10 minutes of AWAKE time
 * is terminated through the transport and parked under the automatic
 * launch-retry category. A sample at any age, another provider, host sleep or
 * a denied kill leaves the row exactly as it was.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { createTicket } from '../../../store/tickets.js';
import { upsertProject } from '../../../store/projects.js';
import { FIRST_ACTIVITY_WAIT_MS } from './sweep.js';
import type { TerminationProof } from '../transport/agentTransport.js';
import {
  runFirstActivityWatchdog,
  type FirstActivityTarget,
  type FirstActivityWatchdogDeps,
} from './firstActivity.js';

const NOW = '2026-11-26T10:00:00.000Z';
const MINUTE = 60_000;

let store: Store;
let ticketId: number;
let graphAttempt = 0;

interface Fixture {
  graphRunId: number;
  revisionId: number;
  nodeRunId: number;
  processRunId: number;
  deps: FirstActivityWatchdogDeps;
  terminations: FirstActivityTarget[];
  diagnostics: string[];
  setProof(proof: TerminationProof | undefined): void;
  startAt(minutesAgo: number): string;
}

function fixture(input: {
  provider?: string;
  placement?: string | null;
  status?: string;
  startedAt?: string;
  /** The start of the CURRENT launch (`process_runs.started_at`); defaults to `startedAt`. */
  launchedAt?: string;
  awakeElapsedMs?: (sinceMs: number, nowMs: number) => number;
  proof?: TerminationProof | undefined;
} = {}): Fixture {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at)
         VALUES (?, 'impl', ?, 'x', 'running', 1, ?)`,
      )
      .run(ticketId, graphAttempt++, NOW).lastInsertRowid,
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
  const startedAt = input.startedAt ?? new Date(Date.parse(NOW) - 10 * MINUTE).toISOString();
  const processRunId = openLaunch(input.launchedAt ?? startedAt);
  const nodeRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, provider,
            process_run_id, started_at)
         VALUES (?, ?, 'impl', 'agent', 1, ?, ?, ?, ?)`,
      )
      .run(
        graphRunId,
        revisionId,
        input.status ?? 'running',
        input.provider ?? 'opencode2',
        processRunId,
        startedAt,
      ).lastInsertRowid,
  );
  if (input.placement !== undefined) {
    store.db
      .prepare('UPDATE tickets SET placement_backend = ? WHERE id = ?')
      .run(input.placement, ticketId);
  }

  const terminations: FirstActivityTarget[] = [];
  const diagnostics: string[] = [];
  let proof = ('proof' in input ? input.proof : { kind: 'attributable', kill: 'killed' }) as
    | TerminationProof
    | undefined;
  const deps: FirstActivityWatchdogDeps = {
    db: store.db,
    transaction: <T>(fn: () => T): T => store.db.transaction(fn)(),
    now: () => NOW,
    debug: (message) => diagnostics.push(message),
    awakeElapsedMs: input.awakeElapsedMs ?? ((sinceMs, nowMs) => nowMs - sinceMs),
    terminateSession: async (target) => {
      terminations.push(target);
      return proof;
    },
  };
  return {
    graphRunId,
    revisionId,
    nodeRunId,
    processRunId,
    deps,
    terminations,
    diagnostics,
    setProof(next) {
      proof = next;
    },
    startAt(minutesAgo: number): string {
      return new Date(Date.parse(NOW) - minutesAgo * MINUTE).toISOString();
    },
  };
}

/** Open the `process_runs` row of one launch, as the transport seam does. */
function openLaunch(startedAt: string): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'impl', 'graph-node', 0, 'running', ?)`,
      )
      .run(ticketId, startedAt).lastInsertRowid,
  );
}

function nodeRow(id: number): {
  status: string;
  reason: string | null;
  launch_fail_streak: number;
} {
  return store.db
    .prepare('SELECT status, reason, launch_fail_streak FROM approach_node_runs WHERE id = ?')
    .get(id) as { status: string; reason: string | null; launch_fail_streak: number };
}

function runRow(id: number): { status: string; blocked_reason: string | null } {
  return store.db
    .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
    .get(id) as { status: string; blocked_reason: string | null };
}

function addSample(processRunId: number): void {
  store.db
    .prepare(
      `INSERT INTO interactive_usage_samples
         (process_run_id, source_event_id, provider, provider_session_id,
          input_tokens, output_tokens, observed_at)
       VALUES (?, 'evt-1', 'opencode2', 'sess-1', 10, 5, ?)`,
    )
    .run(processRunId, NOW);
}

beforeEach(() => {
  store = openStore(':memory:');
  graphAttempt = 0;
  const projectId = upsertProject(store, { slug: 'p' }).id;
  ticketId = createTicket(store, { key: 'GP-1', title: 'thing', projectId }).id;
});
afterEach(() => store.close());

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * MINUTE).toISOString();
}

describe('runFirstActivityWatchdog', () => {
  it('terminates and parks an opencode2 node with no sample after 10 awake minutes', async () => {
    const h = fixture();
    const result = await runFirstActivityWatchdog(h.deps, h.graphRunId);

    expect(result).toEqual({ checked: 1, stopped: 1 });
    expect(h.terminations).toEqual([{ graphRunId: h.graphRunId, nodeRunId: h.nodeRunId }]);
    const node = nodeRow(h.nodeRunId);
    expect(node.status).toBe('blocked');
    expect(node.reason).toBe('no session activity 10 min after launch');
    // `providerExit = false`: the provider-exit loop counter is cleared, never advanced.
    expect(node.launch_fail_streak).toBe(0);
    const run = runRow(h.graphRunId);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(new RegExp(`^node-blocked: node run ${h.nodeRunId} showed no session activity 10 min after launch`));
    const line = h.diagnostics.find((d) => d.startsWith('[graph:block]'));
    expect(line).toBeDefined();
    expect(line).toContain(`node=${h.nodeRunId}`);
    expect(line).toContain('opencode2');
    expect(line).toContain('10 min');
  });

  it('leaves the node running at 9 awake minutes', async () => {
    const h = fixture({ startedAt: new Date(Date.parse(NOW) - 9 * MINUTE).toISOString() });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
    expect(runRow(h.graphRunId).status).toBe('running');
  });

  it('never stops a node that has one sample, even after 60 minutes', async () => {
    const h = fixture({ startedAt: new Date(Date.parse(NOW) - 60 * MINUTE).toISOString() });
    addSample(h.processRunId);
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
  });

  it('never stops a codex node', async () => {
    const h = fixture({ provider: 'codex' });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
  });

  it('does not count host sleep: 15 wall minutes with 10 asleep is 5 awake', async () => {
    const h = fixture({
      startedAt: new Date(Date.parse(NOW) - 15 * MINUTE).toISOString(),
      awakeElapsedMs: (sinceMs, nowMs) => nowMs - sinceMs - 10 * MINUTE,
    });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
  });

  it('leaves the row untouched when the attributable kill is denied', async () => {
    const h = fixture({ proof: { kind: 'attributable', kill: 'denied' } });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(nodeRow(h.nodeRunId).status).toBe('running');
    expect(runRow(h.graphRunId).status).toBe('running');
    expect(h.diagnostics.filter((d) => d.includes('denied'))).toHaveLength(1);
  });

  it('leaves the row untouched when no session is found, or the proof is unknown', async () => {
    const absent = fixture({ proof: undefined });
    expect(await runFirstActivityWatchdog(absent.deps, absent.graphRunId)).toEqual({
      checked: 1,
      stopped: 0,
    });
    expect(nodeRow(absent.nodeRunId).status).toBe('running');

    const unknown = fixture({ proof: { kind: 'unknown' } });
    expect(await runFirstActivityWatchdog(unknown.deps, unknown.graphRunId)).toEqual({
      checked: 1,
      stopped: 0,
    });
    expect(nodeRow(unknown.nodeRunId).status).toBe('running');
  });

  it('leaves the row untouched when termination throws', async () => {
    const h = fixture();
    h.deps.terminateSession = async () => {
      throw new Error('transport gone');
    };
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(nodeRow(h.nodeRunId).status).toBe('running');
    expect(runRow(h.graphRunId).status).toBe('running');
    expect(h.diagnostics.some((d) => d.includes('transport gone'))).toBe(true);
  });

  it('checks a claude node on host placement and skips a claude node on a sandbox placement', async () => {
    const host = fixture({ provider: 'claude', placement: 'host' });
    expect(await runFirstActivityWatchdog(host.deps, host.graphRunId)).toEqual({
      checked: 1,
      stopped: 1,
    });
    expect(nodeRow(host.nodeRunId).status).toBe('blocked');

    const sandbox = fixture({ provider: 'claude', placement: 'sandbox' });
    expect(await runFirstActivityWatchdog(sandbox.deps, sandbox.graphRunId)).toEqual({
      checked: 1,
      stopped: 0,
    });
    expect(sandbox.terminations).toEqual([]);
    expect(nodeRow(sandbox.nodeRunId).status).toBe('running');
  });

  it('skips a running node with no process run or no start', async () => {
    const h = fixture();
    store.db
      .prepare('UPDATE approach_node_runs SET process_run_id = NULL WHERE id = ?')
      .run(h.nodeRunId);
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });

    store.db.prepare('UPDATE approach_node_runs SET started_at = NULL WHERE id = ?').run(h.nodeRunId);
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
  });

  it('measures the window from the CURRENT launch, so a relaunch of an old node is not stopped', async () => {
    // The node was first claimed 40 minutes ago (`started_at` keeps that
    // claim); the relaunch opened a new process run 1 minute ago.
    const h = fixture({ startedAt: minutesAgo(40), launchedAt: minutesAgo(1) });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toEqual([]);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
  });

  it('stops a relaunch only after 10 awake minutes of its own launch', async () => {
    const h = fixture({ startedAt: minutesAgo(40), launchedAt: minutesAgo(10) });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 1 });
    expect(nodeRow(h.nodeRunId).reason).toBe('no session activity 10 min after launch');
  });

  it('gives a relaunch after a watchdog park a new full window', async () => {
    const h = fixture({ startedAt: minutesAgo(10) });
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 1 });
    // Autorecovery relaunches the SAME row: blocked -> running with a new process run.
    const relaunch = openLaunch(NOW);
    store.db
      .prepare("UPDATE approach_node_runs SET status = 'running', process_run_id = ? WHERE id = ?")
      .run(relaunch, h.nodeRunId);
    store.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?").run(h.graphRunId);
    expect(await runFirstActivityWatchdog(h.deps, h.graphRunId)).toEqual({ checked: 1, stopped: 0 });
    expect(h.terminations).toHaveLength(1);
    expect(nodeRow(h.nodeRunId).status).toBe('running');
  });

  it('exposes the ten-minute awake limit next to the deferral ceiling', () => {
    expect(FIRST_ACTIVITY_WAIT_MS).toBe(10 * MINUTE);
  });
});
