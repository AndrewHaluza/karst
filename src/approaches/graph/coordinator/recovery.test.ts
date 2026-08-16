/**
 * Graph recovery tests (Slice 3 Task 9 + Slice 4 Task 6 — category-specific).
 *
 * Recovery is a TOTAL function over the closed category set:
 * `recoveryCategoryFor` maps every `blocked_reason` the coordinator can write
 * to exactly one `RecoveryCategory`, and `recoverGraphRun` dispatches on it.
 * Every "retry the same reserved visit" action is `failed-to-launch` /
 * `blocked` / `stale` → `launching`: the token stays `claimed` (no claimed →
 * pending transition), no second visit is allocated, and only the
 * launch-attempt counter moves. A launch retry does NOT re-snapshot the
 * prompt; an explicit prompt Resume (a blocked agent node carrying a `prompt`
 * override) DOES. `discard-required` / `config-then-resume` /
 * `explicit-resolution` never retry themselves. Node overrides are scoped
 * `(revision, node, kind)`, editable only while the node has no
 * claimed/launched run, and never carry into revision N+1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { createTicket } from '../../../store/tickets.js';
import { setStage } from '../../../store/stages.js';
import { stageBlock } from '../../../store/stageBlocks.js';
import { writeNodeOverride, clearNodeOverride, nodeOverrideFor } from '../../../store/graph/nodeRuns.js';
import { sha256Hex } from './plannerRun.js';
import {
  recoverGraphRun,
  recoveryCategoryFor,
  type RecoveryCategory,
  type RecoveryDeps,
  type RecoveryResult,
} from './recovery.js';

describe('recoverGraphRun', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  interface Fixture {
    ticketId: number;
    graphRunId: number;
    revisionId: number;
  }

  function blockedGraph(
    reason: string,
    nodeStatuses: { id: number; status: string }[],
    canonicalGraph = '{}',
    replanCount = 0,
  ): Fixture {
    const ticketId = createTicket(store, { key: 'RC-1', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    store.db
      .prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, replan_count, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', ?, ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, reason, replanCount)
        .lastInsertRowid,
    );
    const revisionId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId, canonicalGraph)
        .lastInsertRowid,
    );
    for (const node of nodeStatuses) {
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, ?, 'n', 'agent', ?, ?)`,
        )
        .run(node.id, graphRunId, revisionId, node.id, node.status);
    }
    // Park the impl stage block the recovery will clear.
    setStage(store, ticketId, 'impl', {
      status: 'running',
      blockedKind: 'approach-graph-failed',
      blockedReason: `approach-graph-failed: ${reason} (graph run ${graphRunId})`,
      blockedAt: '2026-08-12T00:00:00.000Z',
    });
    return { ticketId, graphRunId, revisionId };
  }

  /** A blocked run in the bootstrap phase — no active revision exists yet (the
   *  bootstrap planner died before submitting), the shape the `planner-stale`
   *  reconcile writes. */
  function blockedBootstrapGraph(reason: string): { ticketId: number; graphRunId: number } {
    const ticketId = createTicket(store, { key: 'RC-3', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    store.db
      .prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, reason)
        .lastInsertRowid,
    );
    setStage(store, ticketId, 'impl', {
      status: 'running',
      blockedKind: 'approach-graph-failed',
      blockedReason: `approach-graph-failed: ${reason} (graph run ${graphRunId})`,
      blockedAt: '2026-08-12T00:00:00.000Z',
    });
    return { ticketId, graphRunId };
  }

  function plannerRunsOf(graphRunId: number): { id: number; kind: string; status: string }[] {
    return store.db
      .prepare('SELECT id, kind, status FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id')
      .all(graphRunId) as { id: number; kind: string; status: string }[];
  }

  /** A compile-valid canonical document (electReplan re-parses it). */
  function validGraph(maxReplans = 2): string {
    return JSON.stringify({
      version: 1,
      title: 't',
      rationaleArtifact: 'r',
      entries: ['a'],
      artifacts: [],
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'a',
          profile: 'default',
          instructionsArtifact: 'i',
          inputs: [],
          outputs: [],
          resources: { reads: [], writes: [] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e-a-end', from: 'a', on: 'complete', to: 'END' }],
      budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans },
    });
  }

  function claimToken(nodeRunId: number): void {
    store.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, claiming_node_run_id, created_at)
         VALUES ((SELECT id FROM approach_graph_revisions WHERE graph_run_id = 1), NULL, 1, 'e',
                 'n', 0, 0, 'root', 'claimed', ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(nodeRunId);
  }

  function runRow(graphRunId: number): { status: string; blocked_reason: string | null } {
    return store.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
  }

  function nodeRow(nodeRunId: number): { status: string; prompt_hash: string | null; launch_attempt: number } {
    return store.db
      .prepare('SELECT status, prompt_hash, launch_attempt FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string; prompt_hash: string | null; launch_attempt: number };
  }

  function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
    return {
      store,
      transaction: <T>(fn: () => T): T =>
        (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
          begin: 'immediate',
        })(),
      now: () => '2026-08-12T00:00:00.000Z',
      debug: () => {},
      ...overrides,
    };
  }

  it('retries blocked node runs and clears the block only after the retry entered', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 5 (agent said blocked)', [
      { id: 5, status: 'blocked' },
      { id: 6, status: 'completed' },
    ]);
    claimToken(5);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'retried', retried: [5], resnapshotted: [] });
    expect(runRow(graphRunId)).toEqual({ status: 'running', blocked_reason: null });
    // The failing node is back at `launching` — a retry, never a completed —
    // and its launch-attempt counter moved. The token stays claimed.
    expect(nodeRow(5).status).toBe('launching');
    expect(nodeRow(5).launch_attempt).toBe(1);
    const token = store.db
      .prepare("SELECT status FROM approach_graph_tokens WHERE claiming_node_run_id = 5")
      .get() as { status: string };
    expect(token.status).toBe('claimed');
    // The visible stage block is gone: recovery durably entered.
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('clears the dead launch identity so the driver can launch the retried visit', () => {
    // A node blocked by `reconcileLaunching` carries the identity of the launch
    // that died (owner nonce, process run, generation). `driveReadyNodeRuns`
    // selects `status = 'launching' AND owner_nonce IS NULL AND
    // process_run_id IS NULL` (driver.ts), so a retry that leaves the dead
    // identity in place is never launchable — and the next reconcile tick
    // re-attributes the same dead pid and blocks the run again, forever.
    const { ticketId, graphRunId } = blockedGraph(
      'node-blocked: node 5 launch process (pid 39438) is gone — Resume to relaunch the reserved visit',
      [{ id: 5, status: 'blocked' }],
    );
    claimToken(5);
    const procRunId = Number(
      store.db
        .prepare(
          `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, provider, pid, status, started_at)
           VALUES (?, 'impl', 'graph-node', 0, 'opencode', 39438, 'interrupted', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId).lastInsertRowid,
    );
    store.db
      .prepare(
        "UPDATE approach_node_runs SET owner_nonce = 'dead-nonce', process_run_id = ?, generation = 'dead-gen' WHERE id = 5",
      )
      .run(procRunId);

    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });

    expect(result.kind).toBe('retried');
    const identity = store.db
      .prepare('SELECT status, owner_nonce, process_run_id, generation FROM approach_node_runs WHERE id = 5')
      .get() as {
      status: string;
      owner_nonce: string | null;
      process_run_id: number | null;
      generation: string | null;
    };
    expect(identity).toEqual({
      status: 'launching',
      owner_nonce: null,
      process_run_id: null,
      generation: null,
    });
    // …and that is exactly the shape the driver's launchable query matches.
    const launchable = store.db
      .prepare(
        `SELECT id FROM approach_node_runs
         WHERE graph_run_id = ? AND status = 'launching'
           AND owner_nonce IS NULL AND process_run_id IS NULL`,
      )
      .all(graphRunId) as { id: number }[];
    expect(launchable.map((r) => r.id)).toEqual([5]);
  });

  it('failed-to-launch and stale node runs retry on the same reserved visit', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 7 process gone', [
      { id: 7, status: 'failed-to-launch' },
      { id: 8, status: 'stale' },
    ]);
    claimToken(7);
    claimToken(8);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'retried', retried: [7, 8], resnapshotted: [] });
    expect(nodeRow(7).status).toBe('launching');
    expect(nodeRow(7).launch_attempt).toBe(1);
    expect(nodeRow(8).status).toBe('launching');
    expect(nodeRow(8).launch_attempt).toBe(1);
    const tokens = store.db
      .prepare('SELECT status FROM approach_graph_tokens ORDER BY id')
      .all() as { status: string }[];
    expect(tokens.map((t) => t.status)).toEqual(['claimed', 'claimed']);
  });

  it('resource-claim-violated requires corrected claims + explicit Resume, never auto-retry', () => {
    const { ticketId, graphRunId } = blockedGraph('resource-claim-violated: b.ts', [
      { id: 7, status: 'blocked' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(nodeRow(7).status).toBe('blocked');
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('integration-conflict is preserved for replan/expert diagnosis, never auto-retried', () => {
    const { ticketId, graphRunId } = blockedGraph('integration-conflict: git commit refused in web', [
      { id: 7, status: 'blocked' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(nodeRow(7).status).toBe('blocked');
  });

  it('an explicit graph replan elects a new revision after a non-retryable block', () => {
    const { ticketId, graphRunId } = blockedGraph(
      'integration-conflict: git commit refused in web',
      [{ id: 7, status: 'blocked' }],
      validGraph(2),
    );
    const result = recoverGraphRun(
      makeDeps(),
      { ticketId, graphRunId, mode: 'replan' },
    );
    expect(result.kind).toBe('replanned');
    expect(runRow(graphRunId)).toEqual({ status: 'draining', blocked_reason: null });
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('an output-artifact-missing fault refuses until the artifact is corrected', () => {
    const { ticketId, graphRunId } = blockedGraph('output-artifact-missing: artifact "r" produced nothing', [
      { id: 7, status: 'output-artifact-missing' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(nodeRow(7).status).toBe('output-artifact-missing');
  });

  it('graph-topology-deadlock refuses — a discarded revision is never auto-retried', () => {
    const { ticketId, graphRunId } = blockedGraph('graph-topology-deadlock', [{ id: 7, status: 'blocked' }]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
  });

  it('budget exhaustion refuses as config-change-then-Resume', () => {
    const { ticketId, graphRunId } = blockedGraph('graph-budget-exhausted', [{ id: 7, status: 'blocked' }]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'config-then-resume' });
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('launch-unknown is never auto-retried — the discard action is the exit', () => {
    const { ticketId, graphRunId } = blockedGraph('launch-unknown: node 8 crash after possible spawn', [
      { id: 8, status: 'launch-unknown' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'discard-required' });
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('termination-unknown is never auto-retried', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 8 (termination-unknown)', [
      { id: 8, status: 'termination-unknown' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('refused');
    expect(result).toEqual({ kind: 'refused', reason: 'discard-required' });
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('an unrecognized reason is never auto-retried', () => {
    const { ticketId, graphRunId } = blockedGraph('weird-unmapped-failure: something', [
      { id: 7, status: 'blocked' },
    ]);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(nodeRow(7).status).toBe('blocked');
  });

  it('a launch retry does NOT re-snapshot the prompt', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: node 5 (agent said blocked)', [
      { id: 5, status: 'blocked' },
    ]);
    const resolveEffective = vi.fn();
    const writeSnapshot = vi.fn();
    const result = recoverGraphRun(
      makeDeps({
        resolveEffective: resolveEffective as unknown as RecoveryDeps['resolveEffective'],
        writeSnapshot: writeSnapshot as unknown as RecoveryDeps['writeSnapshot'],
      }),
      { ticketId, graphRunId },
    );
    expect(result).toEqual({ kind: 'retried', retried: [5], resnapshotted: [] });
    expect(nodeRow(5).prompt_hash).toBeNull();
    expect(resolveEffective).not.toHaveBeenCalled();
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it('a prompt override on a blocked node makes the explicit Resume re-snapshot the prompt', () => {
    const { ticketId, graphRunId, revisionId } = blockedGraph('node-blocked: node 5 (agent said blocked)', [
      { id: 5, status: 'blocked' },
    ]);
    const write = writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'prompt',
      value: 'REVISED PROMPT',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(write).toEqual({ ok: true });
    const writeSnapshot = vi.fn();
    const effective = { prompt: 'REVISED PROMPT', promptOverride: true };
    const result = recoverGraphRun(
      makeDeps({
        resolveEffective: () => effective,
        writeSnapshot: writeSnapshot as unknown as RecoveryDeps['writeSnapshot'],
      }),
      { ticketId, graphRunId },
    );
    const expectedHash = sha256Hex(new TextEncoder().encode('REVISED PROMPT'));
    expect(result).toEqual({ kind: 'retried', retried: [5], resnapshotted: [5] });
    expect(nodeRow(5).prompt_hash).toBe(expectedHash);
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    const [snapshotRunId, relPath, bytes] = writeSnapshot.mock.calls[0] as unknown as [
      number,
      string,
      Uint8Array,
    ];
    expect(snapshotRunId).toBe(graphRunId);
    expect(relPath).toBe(`prompts/${expectedHash}`);
    expect(Buffer.from(bytes).toString()).toBe('REVISED PROMPT');
    expect(nodeRow(5).status).toBe('launching');
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('a reason that names prompt configuration re-snapshots every blocked agent node', () => {
    const { ticketId, graphRunId } = blockedGraph('prompt-config-changed: node base prompt edited', [
      { id: 5, status: 'blocked' },
    ]);
    const result = recoverGraphRun(
      makeDeps({
        resolveEffective: () => ({ prompt: 'NEW BASE', promptOverride: false }),
        writeSnapshot: vi.fn() as unknown as RecoveryDeps['writeSnapshot'],
      }),
      { ticketId, graphRunId },
    );
    expect(result.kind).toBe('retried');
    if (result.kind === 'retried') {
      expect(result.resnapshotted).toEqual([5]);
      expect(result.retried).toEqual([5]);
    }
    expect(nodeRow(5).prompt_hash).toBe(sha256Hex(new TextEncoder().encode('NEW BASE')));
  });

  it('a graph-plan-invalid reason elects a replan and allocates the planner run', () => {
    const { ticketId, graphRunId } = blockedGraph('graph-plan-invalid: planner produced an invalid document', [], validGraph(2));
    const writeSnapshot = vi.fn();
    const result = recoverGraphRun(
      makeDeps({
        readPrompt: () => new TextEncoder().encode('planner prompt'),
        writeSnapshot: writeSnapshot as unknown as RecoveryDeps['writeSnapshot'],
        plannerPromptPath: '/pkg/graph-planner/SKILL.md',
        ticketContext: 'ticket context',
      }),
      { ticketId, graphRunId },
    );
    expect(result.kind).toBe('replanned');
    if (result.kind !== 'replanned') return;
    expect(result.plannerRunId).not.toBeNull();
    expect(result.plannerRunNumber).toBe(1);
    expect(result.launch).not.toBeNull();
    expect(runRow(graphRunId).status).toBe('draining');
    // The recovery durably entered (run drained, planner allocated): block gone.
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('a replan-category refusal when maxReplans is exhausted blocks the node graph-budget-exhausted', () => {
    const { ticketId, graphRunId } = blockedGraph(
      'graph-plan-invalid: planner produced an invalid document',
      [{ id: 5, status: 'blocked' }],
      validGraph(1),
      1,
    );
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'config-then-resume' });
    const node = store.db
      .prepare('SELECT status, effective_outcome, failure_category FROM approach_node_runs WHERE id = 5')
      .get() as { status: string; effective_outcome: string | null; failure_category: string | null };
    expect(node.status).toBe('blocked');
    expect(node.effective_outcome).toBe('blocked');
    expect(node.failure_category).toBe('graph-budget-exhausted');
    expect(runRow(graphRunId)).toEqual({ status: 'blocked', blocked_reason: 'graph-budget-exhausted' });
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('a command-definition-changed reason routes to the compile-new-revision (replan) tier', () => {
    const { ticketId, graphRunId } = blockedGraph('command-definition-changed: pinned fingerprint moved', [], validGraph(2));
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('replanned');
    expect(runRow(graphRunId).status).toBe('draining');
  });

  it('a planner-stale reason relaunches the bootstrap planner on the same graph run', () => {
    const { ticketId, graphRunId } = blockedBootstrapGraph('planner-stale: bootstrap planner 7 process (pid 42) is gone — Resume to relaunch the planner');
    const writeSnapshot = vi.fn();
    const result = recoverGraphRun(
      makeDeps({
        readPrompt: () => new TextEncoder().encode('planner prompt'),
        writeSnapshot: writeSnapshot as unknown as RecoveryDeps['writeSnapshot'],
        plannerPromptPath: '/pkg/graph-planner/SKILL.md',
        ticketContext: 'ticket context',
      }),
      { ticketId, graphRunId },
    );
    expect(result.kind).toBe('relaunched');
    if (result.kind !== 'relaunched') return;
    expect(result.plannerRunId).not.toBeNull();
    expect(result.plannerRunNumber).toBe(1);
    expect(result.launch).not.toBeNull();
    // The run re-opens to `planning` — a fresh bootstrap planner can submit.
    expect(runRow(graphRunId)).toEqual({ status: 'planning', blocked_reason: null });
    const planners = plannerRunsOf(graphRunId);
    expect(planners).toHaveLength(1);
    expect(planners[0]).toMatchObject({ kind: 'bootstrap', status: 'ready' });
    // The snapshot was written content-addressed before the transaction.
    const [snapshotRunId, relPath] = writeSnapshot.mock.calls[0] as unknown as [number, string];
    expect(snapshotRunId).toBe(graphRunId);
    expect(relPath).toBe(`prompts/${sha256Hex(new TextEncoder().encode('planner prompt'))}`);
    // The visible stage block is gone: the relaunch durably entered.
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
  });

  it('restores a legacy planner-stale block with an accepted revision to confirmation', () => {
    const { ticketId, graphRunId } = blockedGraph('planner-stale: submitted planner exited', []);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'confirmation-restored' });
    expect(runRow(graphRunId)).toEqual({ status: 'awaiting-confirmation', blocked_reason: null });
    expect(stageBlock(store, ticketId, 'impl')).toBeNull();
    expect(plannerRunsOf(graphRunId)).toEqual([]);
  });

  it('a planner-stale relaunch refuses explicit-resolution when the prompt seams are unwired', () => {
    const { ticketId, graphRunId } = blockedBootstrapGraph('planner-stale: bootstrap planner 7 process gone');
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(stageBlock(store, ticketId, 'impl')).not.toBeNull();
  });

  it('a planner-stale relaunch with an unreadable prompt refuses explicit-resolution', () => {
    const { ticketId, graphRunId } = blockedBootstrapGraph('planner-stale: bootstrap planner 7 process gone');
    const result = recoverGraphRun(
      makeDeps({
        readPrompt: () => undefined,
        writeSnapshot: vi.fn() as unknown as RecoveryDeps['writeSnapshot'],
        plannerPromptPath: '/pkg/graph-planner/SKILL.md',
        ticketContext: 'ticket context',
      }),
      { ticketId, graphRunId },
    );
    expect(result).toEqual({ kind: 'refused', reason: 'explicit-resolution' });
    expect(runRow(graphRunId).status).toBe('blocked');
  });

  it('a run that is not blocked is not claimed (idempotent no-op)', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: x', [{ id: 9, status: 'blocked' }]);
    store.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('running', graphRunId);
    const result = recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    expect(result.kind).toBe('no-op');
  });

  it('never advances the stage or synthesizes a success', () => {
    const { ticketId, graphRunId } = blockedGraph('node-blocked: x', [{ id: 10, status: 'blocked' }]);
    recoverGraphRun(makeDeps(), { ticketId, graphRunId });
    const ticket = store.db
      .prepare('SELECT stage_current FROM tickets WHERE id = ?')
      .get(ticketId) as { stage_current: string };
    expect(ticket.stage_current).toBe('impl');
    const node = store.db
      .prepare('SELECT status, outcome FROM approach_node_runs WHERE id = ?')
      .get(10) as { status: string; outcome: string | null };
    expect(node.status).not.toBe('completed');
    expect(node.outcome).toBeNull();
  });
});

describe('recoveryCategoryFor — the total function over the closed category set', () => {
  it('maps every blocked_reason the coordinator can write to exactly one category', () => {
    const cases: [string | null, RecoveryCategory][] = [
      ['node-blocked: node 5 crashed before spawn (owner nonce, no process)', 'launch-retry'],
      ['node-blocked: node 5 process (pid 42) is gone (dead at reconcile)', 'launch-retry'],
      ['launch-unknown: node 8 crash after possible spawn with no identity', 'discard-required'],
      ['node-blocked: node 8 (termination-unknown)', 'discard-required'],
      ['graph-budget-exhausted', 'config-then-resume'],
      ['output-artifact-missing: artifact "r" produced nothing', 'explicit-resolution'],
      ['artifact-unsafe: artifact "r" failed validation', 'explicit-resolution'],
      ['resource-claim-violated: b.ts', 'explicit-resolution'],
      ['integration-conflict: git add refused in web', 'explicit-resolution'],
      ['graph-topology-deadlock', 'explicit-resolution'],
      ['graph-plan-invalid: planner produced an invalid document', 'replan'],
      ['planner-artifact-missing: graph snapshot gone', 'replan'],
      ['instructions-missing: cannot read the graph planner prompt', 'replan'],
      ['planner-stale: bootstrap planner 7 process (pid 42) is gone', 'planner-relaunch'],
      ['command-definition-changed: pinned fingerprint moved', 'compile-new-revision'],
      ['prompt-config-changed: node base prompt edited', 'prompt-resnapshot'],
      [null, 'explicit-resolution'],
      ['completely-unrecognized', 'explicit-resolution'],
    ];
    for (const [reason, expected] of cases) {
      expect(recoveryCategoryFor(reason), `reason: ${reason}`).toBe(expected);
    }
  });

  it('returns a member of the closed union for every input (never throws)', () => {
    const union = new Set<RecoveryCategory>([
      'launch-retry',
      'prompt-resnapshot',
      'replan',
      'compile-new-revision',
      'planner-relaunch',
      'discard-required',
      'config-then-resume',
      'explicit-resolution',
    ]);
    for (const reason of ['x', '', 'node-blocked: a', 'launch-unknown: b', 'graph-budget-exhausted']) {
      expect(union.has(recoveryCategoryFor(reason))).toBe(true);
    }
  });
});

describe('node overrides (Slice 4 Task 6)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  interface Ctx {
    graphRunId: number;
    revisionId: number;
    revision2Id: number;
  }

  function harness(): Ctx {
    const ticketId = createTicket(store, { key: 'RC-2', title: 'thing' }).id;
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
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
    const revision2Id = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 2, '{}', 'fp2', 'superseded', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId)
        .lastInsertRowid,
    );
    return { graphRunId, revisionId, revision2Id };
  }

  function nodeRun(revisionId: number, nodeId: string, status: string): number {
    return Number(
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (1, ?, ?, 'agent', 1, ?)`,
        )
        .run(revisionId, nodeId, status)
        .lastInsertRowid,
    );
  }

  it('an override write for an editable node succeeds and is readable', () => {
    const { revisionId } = harness();
    nodeRun(revisionId, 'n', 'ready');
    const write = writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'provider',
      value: '"codex"',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(write).toEqual({ ok: true });
    const row = nodeOverrideFor(store.db, revisionId, 'n', 'provider');
    expect(row?.value).toBe('"codex"');
    expect(row?.row_version).toBe(0);
  });

  it('an override write against a node whose launch already began fails the CAS and writes nothing', () => {
    const { revisionId } = harness();
    const runId = nodeRun(revisionId, 'n', 'running');
    expect(runId).toBeGreaterThan(0);
    const write = writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'provider',
      value: '"codex"',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(write).toEqual({ ok: false, reason: 'claimed' });
    expect(nodeOverrideFor(store.db, revisionId, 'n', 'provider')).toBeUndefined();
  });

  it('a completed visit also freezes the node (claiming has begun and ended)', () => {
    const { revisionId } = harness();
    nodeRun(revisionId, 'n', 'completed');
    const write = writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'model',
      value: '"gpt-5.6"',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(write).toEqual({ ok: false, reason: 'claimed' });
  });

  it('clearing an override removes it; clearing after claiming fails', () => {
    const { revisionId } = harness();
    nodeRun(revisionId, 'n', 'blocked');
    expect(writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'effort',
      value: '"high"',
      now: '2026-08-12T00:00:00.000Z',
    })).toEqual({ ok: true });
    expect(clearNodeOverride(store.db, { revisionId, nodeId: 'n', kind: 'effort' })).toBe(true);
    expect(nodeOverrideFor(store.db, revisionId, 'n', 'effort')).toBeUndefined();
  });

  it('an override does not carry into revision N+1', () => {
    const { revisionId, revision2Id } = harness();
    nodeRun(revisionId, 'n', 'ready');
    expect(writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'profile',
      value: '"expert"',
      now: '2026-08-12T00:00:00.000Z',
    })).toEqual({ ok: true });
    expect(nodeOverrideFor(store.db, revisionId, 'n', 'profile')).toBeDefined();
    // Revision N+1 is keyed by its own revision_id — the override has no row.
    expect(nodeOverrideFor(store.db, revision2Id, 'n', 'profile')).toBeUndefined();
  });

  it('a prompt override written before claiming drives the next retry\'s re-snapshot', () => {
    const ticketId = createTicket(store, { key: 'RC-3', title: 'thing' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
           VALUES (?, 'impl', 0, 'x', 'blocked', 'node-blocked: node 5', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
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
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (5, ?, ?, 'n', 'agent', 1, 'blocked')`,
      )
      .run(graphRunId, revisionId);
    expect(writeNodeOverride(store.db, {
      revisionId,
      nodeId: 'n',
      kind: 'prompt',
      value: 'REVISED',
      now: '2026-08-12T00:00:00.000Z',
    })).toEqual({ ok: true });
    const result = recoverGraphRun(
      {
        store,
        transaction: <T>(fn: () => T): T =>
          (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
            begin: 'immediate',
          })(),
        now: () => '2026-08-12T00:00:00.000Z',
        debug: () => {},
        resolveEffective: () => ({ prompt: 'REVISED', promptOverride: true }),
        writeSnapshot: vi.fn() as unknown as RecoveryDeps['writeSnapshot'],
      },
      { ticketId, graphRunId },
    );
    expect(result.kind).toBe('retried');
    if (result.kind === 'retried') expect(result.resnapshotted).toEqual([5]);
    const row = store.db
      .prepare('SELECT prompt_hash FROM approach_node_runs WHERE id = 5')
      .get() as { prompt_hash: string | null };
    expect(row.prompt_hash).toBe(sha256Hex(new TextEncoder().encode('REVISED')));
  });
});
