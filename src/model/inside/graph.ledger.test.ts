/**
 * The graph's ONE ledger (DYNAMIC-GRAPH-INSIDE-COMPONENT): planner runs, node
 * runs and deferred nodes render as one chronological list, oldest on top,
 * with no status sections; each artifact rides the entry that produced it.
 */

import { describe, it, expect } from 'vitest';
import { graphDagView } from './graphDag.js';
import { graphInsideProcess, type GraphInsideInput, type GraphNodeRunView } from './graph.js';
import { nodeRunStatus } from './graphLedger.js';
import { FAULT_NODE_STATUSES } from '../../approaches/graph/coordinator/completion.js';
import { formatPrStamp } from '../prPanelView.js';

function node(over: Partial<GraphNodeRunView> & Pick<GraphNodeRunView, 'nodeRunId' | 'nodeId'>): GraphNodeRunView {
  return {
    nodeKind: 'agent',
    revisionId: 1,
    visitNumber: 1,
    status: 'completed',
    outcome: 'complete',
    reason: null,
    provider: null,
    model: null,
    effort: null,
    profile: null,
    launchAttempt: 0,
    ...over,
  };
}

function input(over?: Partial<GraphInsideInput>): GraphInsideInput {
  return {
    enabled: true,
    graphRun: {
      id: 7,
      runNumber: 1,
      status: 'running',
      approachId: 'karst-graph-engineering',
      stageAttempt: 0,
      createdAt: '2026-10-05T17:00:00.000Z',
    },
    plannerRuns: [
      {
        plannerRunNumber: 1,
        kind: 'bootstrap',
        status: 'submitted',
        compileAttempt: 0,
        reason: null,
        startedAt: '2026-10-05T17:01:00.000Z',
        submittedAt: '2026-10-05T17:10:00.000Z',
      },
    ],
    nodeRuns: [
      node({ nodeRunId: 3, nodeId: 'migrate-auth', status: 'running', outcome: null, startedAt: '2026-10-05T17:40:00.000Z' }),
      node({ nodeRunId: 1, nodeId: 'design', startedAt: '2026-10-05T17:12:00.000Z', endedAt: '2026-10-05T17:20:00.000Z' }),
      node({ nodeRunId: 2, nodeId: 'foundation', startedAt: '2026-10-05T17:21:00.000Z', endedAt: '2026-10-05T17:39:00.000Z' }),
    ],
    overrides: [],
    deferrals: [
      { nodeId: 'migrate-scope', reason: 'resource-conflict: worktree held', waitSince: '2026-10-05T17:41:00.000Z' },
    ],
    execution: { maxParallel: 2, maxNodeRuns: 40 },
    revision: null,
    diagnostics: [],
    artifacts: [
      { artifactId: 'design-task', mediaType: 'text/markdown', byteSize: 3174, createdAt: '2026-10-05T17:19:00.000Z', producerNodeRunId: 1 },
      { artifactId: 'implementation-plan', mediaType: 'text/markdown', byteSize: 8908, createdAt: '2026-10-05T17:09:00.000Z', producerPlannerRunNumber: 1 },
      { artifactId: 'orphan', mediaType: 'text/plain', byteSize: 10, createdAt: '2026-10-05T17:09:00.000Z' },
    ],
    liveSessions: [{ kind: 'node', runId: 3 }],
    attach: (target) => ({ actionId: 'a', kind: target.kind }),
    now: '2026-10-05T17:50:00.000Z',
    ...over,
  };
}

function ledger(over?: Partial<GraphInsideInput>) {
  const process = graphInsideProcess(input(over))!;
  if (process.evidence?.kind !== 'rows') throw new Error('rows evidence expected');
  return process.evidence;
}

describe('graph ledger', () => {
  it('lists planner, node and deferred entries oldest first with no sections', () => {
    const { nodes } = ledger();
    expect(nodes!.map((n) => [n.entry, n.nodeId])).toEqual([
      ['planner', 'planner 1'],
      ['node', 'design'],
      ['node', 'foundation'],
      ['node', 'migrate-auth'],
      ['deferred', 'migrate-scope'],
    ]);
    expect(nodes!.every((n) => !('group' in n))).toBe(true);
  });

  it('puts an entry with no instant at the end, in input order', () => {
    const { nodes } = ledger({
      nodeRuns: [node({ nodeRunId: 9, nodeId: 'later' }), node({ nodeRunId: 1, nodeId: 'design', startedAt: '2026-10-05T17:12:00.000Z' })],
      deferrals: [],
      plannerRuns: [],
    });
    expect(nodes!.map((n) => n.nodeId)).toEqual(['design', 'later']);
  });

  it('no longer renders planner or deferral entries as flat rows', () => {
    const { rows } = ledger();
    expect(rows.map((r) => r.label)).toEqual(['run 1', 'orphan']);
  });

  it('carries the deferral reason and wait on its ledger entry', () => {
    const deferred = ledger().nodes!.find((n) => n.entry === 'deferred')!;
    expect(deferred.displayStatus).toBe('wait');
    expect(deferred.status).toBe('deferred');
    expect(deferred.reason).toBe('resource-conflict: worktree held');
    expect(deferred.age).toBe('waiting 9m');
  });

  it('nests each artifact under the entry that produced it', () => {
    const { nodes } = ledger();
    expect(nodes!.find((n) => n.nodeId === 'design')!.artifacts).toEqual(['design-task · 3.1 KB']);
    expect(nodes!.find((n) => n.nodeId === 'planner 1')!.artifacts).toEqual(['implementation-plan · 8.7 KB']);
    expect(nodes!.find((n) => n.nodeId === 'foundation')!.artifacts).toBeUndefined();
  });

  it('keeps the planner status verdict and the live-session Open control', () => {
    const { nodes } = ledger({ liveSessions: [{ kind: 'planner', runId: 1 }], plannerRuns: [{ plannerRunNumber: 1, plannerRunId: 1, kind: 'bootstrap', status: 'running', compileAttempt: 0, reason: null, startedAt: '2026-10-05T17:01:00.000Z' }] });
    const planner = nodes!.find((n) => n.entry === 'planner')!;
    expect(planner.displayStatus).toBe('run');
    expect(planner.status).toBe('running');
    expect(planner.action?.kind).toBe('graph-open-session');
  });

  it('caps each entry\'s nested artifacts and appends a remainder', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      artifactId: `a-${i}`,
      mediaType: 'text/plain',
      byteSize: 1,
      createdAt: '2026-10-05T17:19:00.000Z',
      producerNodeRunId: 1,
    }));
    const design = ledger({ artifacts: many }).nodes!.find((n) => n.nodeId === 'design')!;
    expect(design.artifacts).toHaveLength(9);
    expect(design.artifacts![0]).toBe('a-0 · 1 B');
    expect(design.artifacts![8]).toBe('+3 more');
  });

  it('nests on the planner when the node producer is not in the ledger', () => {
    const { nodes } = ledger({
      artifacts: [
        { artifactId: 'x', mediaType: 't', byteSize: 1, createdAt: 'c', producerNodeRunId: 999, producerPlannerRunNumber: 1 },
      ],
    });
    expect(nodes!.find((n) => n.entry === 'planner')!.artifacts).toEqual(['x · 1 B']);
  });

  it('keeps an artifact flat when no producer is in the ledger', () => {
    const { rows } = ledger({
      artifacts: [{ artifactId: 'lost', mediaType: 't', byteSize: 1, createdAt: 'c', producerNodeRunId: 999 }],
    });
    expect(rows.map((r) => r.label)).toContain('lost');
  });

  it('keeps input order for equal instants and normalizes SQLite timestamps as UTC', () => {
    const same = '2026-10-05T17:00:00.000Z';
    const { nodes } = ledger({
      plannerRuns: [],
      deferrals: [],
      nodeRuns: [
        node({ nodeRunId: 2, nodeId: 'b', startedAt: same }),
        node({ nodeRunId: 1, nodeId: 'a', startedAt: same }),
        node({ nodeRunId: 3, nodeId: 'c', startedAt: '2026-10-05 16:00:00' }),
      ],
    });
    expect(nodes!.map((n) => n.nodeId)).toEqual(['c', 'b', 'a']);
  });

  describe('bootstrap planner after the plan is accepted', () => {
    const planner = (over: Partial<GraphInsideInput['plannerRuns'][number]> = {}): GraphInsideInput['plannerRuns'] => [
      {
        plannerRunNumber: 1,
        kind: 'bootstrap',
        status: 'submitted',
        compileAttempt: 0,
        reason: null,
        startedAt: '2026-10-05T17:01:00.000Z',
        submittedAt: '2026-10-05T17:10:00.000Z',
        graphSnapshotId: 'fp1',
        ...over,
      },
    ];
    const rev = { revisionNumber: 1, status: 'active', fingerprint: 'fp', plannerArtifactSnapshotId: 'fp1' };
    const plannerRow = (i: Partial<GraphInsideInput>) => ledger(i).nodes!.find((n) => n.entry === 'planner')!;

    it('reads pass with the accepted revision when a submitted planner has an active revision', () => {
      const row = plannerRow({ plannerRuns: planner(), revision: rev });
      expect(row.displayStatus).toBe('pass');
      expect(row.age).toBe('plan accepted · rev 1 · ran 9m');
    });

    it('keeps the ran duration from ended_at when the planner run has an end', () => {
      const row = plannerRow({
        plannerRuns: planner({ endedAt: '2026-10-05T17:12:00.000Z' }),
        revision: rev,
      });
      expect(row.displayStatus).toBe('pass');
      expect(row.age).toBe('plan accepted · rev 1 · ran 11m');
    });

    it('still waits on the compiler when a submitted planner has no revision', () => {
      const row = plannerRow({ plannerRuns: planner(), revision: null });
      expect(row.displayStatus).toBe('wait');
      expect(row.age).toMatch(/^submitted .* ago$/);
    });

    it('keeps a relaunch planner waiting while the active revision came from an earlier submission', () => {
      const row = plannerRow({ plannerRuns: planner({ graphSnapshotId: 'fp2' }), revision: rev });
      expect(row.displayStatus).toBe('wait');
      expect(row.age).toMatch(/^submitted .* ago$/);
    });

    it('does not read a submitted replan planner as accepted', () => {
      const row = plannerRow({ plannerRuns: planner({ kind: 'replan' }), revision: rev });
      expect(row.displayStatus).toBe('wait');
    });

    it('feeds the DAG chip the accepted reading', () => {
      const nodes = ledger({ plannerRuns: planner(), revision: rev }).nodes!;
      const chip = graphDagView({ nodes: [{ id: 'design' }], edges: [] }, nodes).columns[0]![0]!;
      expect(chip).toMatchObject({ displayStatus: 'pass', label: 'plan', state: 'planner 1 · rev 1 · ran 9m' });
    });
  });

  describe('node details card', () => {
    const TOPOLOGY = {
      nodes: [{ id: 'design', label: 'Design the parser', task: 'design-task' }],
      edges: [],
    };

    function designCard(over: Partial<GraphInsideInput>) {
      const nodes = ledger({ topology: TOPOLOGY, plannerRuns: [], deferrals: [], ...over }).nodes!;
      return nodes.find((n) => n.nodeId === 'design')!.card!;
    }

    it('states the facts in the fixed order with exact strings', () => {
      const start = '2026-10-05T17:12:00.000Z';
      const end = '2026-10-05T17:20:00.000Z';
      const card = designCard({
        nodeRuns: [
          node({
            nodeRunId: 1,
            nodeId: 'design',
            startedAt: start,
            endedAt: end,
            provider: 'codex',
            model: 'sol',
            effort: 'high',
            profile: 'default',
            launchAttempt: 1,
            outcome: 'complete',
            reason: 'compiled the plan',
            tokens: { input: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 0, total: 6_000 },
          }),
        ],
      });
      expect(card.title).toBe('Design the parser');
      expect(card.facts).toEqual([
        { label: 'Role', value: 'default' },
        { label: 'Core', value: 'codex' },
        { label: 'Model', value: 'sol · high' },
        { label: 'Ran', value: `${formatPrStamp(start)} → ${formatPrStamp(end)} (8m 0s)` },
        { label: 'Tokens', value: '6k (3k cache read · 2k out)' },
        { label: 'Visit', value: 'visit 1/40 · relaunched 1×' },
        { label: 'Output', value: 'design-task' },
        { label: 'Task', value: 'design-task' },
        { label: 'Outcome', value: 'complete' },
        { label: 'Reason', value: 'compiled the plan' },
      ]);
    });

    it('reads a run without an end as "since <start>"', () => {
      const start = '2026-10-05T17:12:00.000Z';
      const card = designCard({
        nodeRuns: [node({ nodeRunId: 1, nodeId: 'design', status: 'running', outcome: null, startedAt: start })],
      });
      expect(card.facts.find((f) => f.label === 'Ran')!.value).toBe(`since ${formatPrStamp(start)}`);
    });

    it('leaves the Ran fact out when the run carries no usable start', () => {
      const card = designCard({ nodeRuns: [node({ nodeRunId: 1, nodeId: 'design' })] });
      expect(card.facts.some((f) => f.label === 'Ran')).toBe(false);
    });

    it('leaves the Tokens fact out when the run recorded no measured spend', () => {
      const card = designCard({
        nodeRuns: [node({ nodeRunId: 1, nodeId: 'design', startedAt: '2026-10-05T17:12:00.000Z' })],
      });
      expect(card.facts.some((f) => f.label === 'Tokens')).toBe(false);
    });

    it('caps the Output facts at the row cap and appends the remainder', () => {
      const many = Array.from({ length: 11 }, (_, i) => ({
        artifactId: `a-${i}`,
        mediaType: 'text/plain',
        byteSize: 1,
        createdAt: '2026-10-05T17:19:00.000Z',
        producerNodeRunId: 1,
      }));
      const card = designCard({ artifacts: many, nodeRuns: [node({ nodeRunId: 1, nodeId: 'design' })] });
      const output = card.facts.find((f) => f.label === 'Output')!.value;
      expect(output).toBe('a-0 · a-1 · a-2 · a-3 · a-4 · a-5 · a-6 · a-7 · +3 more');
    });

    it('sanitizes the title', () => {
      const card = designCard({
        topology: {
          nodes: [{ id: 'design', label: 'Design\u001b[31m\n<x> javascript:alert(1)' }],
          edges: [],
        },
        nodeRuns: [node({ nodeRunId: 1, nodeId: 'design' })],
      });
      // eslint-disable-next-line no-control-regex
      expect(card.title).not.toMatch(/[\u0000-\u001f\u001b]/);
      expect(card.title).not.toMatch(/javascript:/i);
      expect(card.title).toContain('Design');
    });

    it('gives the planner entry no card', () => {
      const nodes = ledger({ topology: TOPOLOGY }).nodes!;
      expect(nodes.find((n) => n.entry === 'planner')!.card).toBeUndefined();
      expect(nodes.find((n) => n.entry === 'deferred')!.card).toBeUndefined();
    });
  });

  it('reads a running node with a start time as running, not never started', () => {
    const row = ledger({
      nodeRuns: [node({ nodeRunId: 9, nodeId: 'w', status: 'running', outcome: null, startedAt: '2026-10-05T17:32:00.000Z' })],
    }).nodes!.find((n) => n.nodeId === 'w')!;
    expect(row.age).toBe('running 18m');
  });

  describe('nodeRunStatus', () => {
    // The 15 stored values of `approach_node_runs.status` (migrations.ts, v37
    // CHECK): every one has a reading, so none falls to the pending default by
    // accident.
    const cases: ReadonlyArray<[string, string]> = [
      ['ready', 'pending'],
      ['waiting-resource', 'pending'],
      ['launching', 'run'],
      ['running', 'run'],
      ['completing', 'run'],
      ['integrating', 'run'],
      ['completed', 'pass'],
      ['blocked', 'wait'],
      ['failed-to-launch', 'wait'],
      ['launch-unknown', 'wait'],
      ['termination-unknown', 'wait'],
      ['stale', 'wait'],
      ['output-artifact-missing', 'wait'],
      ['artifact-unsafe', 'wait'],
      ['cancelled', 'skip'],
    ];

    it.each(cases)('maps %s to %s', (status, expected) => {
      expect(nodeRunStatus(status)).toBe(expected);
    });

    it('reads every fault as a wait on recovery', () => {
      for (const status of FAULT_NODE_STATUSES) {
        expect(nodeRunStatus(status), status).toBe('wait');
      }
    });
  });
});
