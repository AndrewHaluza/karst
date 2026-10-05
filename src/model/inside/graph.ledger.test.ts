/**
 * The graph's ONE ledger (DYNAMIC-GRAPH-INSIDE-COMPONENT): planner runs, node
 * runs and deferred nodes render as one chronological list, oldest on top,
 * with no status sections; each artifact rides the entry that produced it.
 */

import { describe, it, expect } from 'vitest';
import { graphInsideProcess, type GraphInsideInput, type GraphNodeRunView } from './graph.js';

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
    expect(rows.map((r) => r.label)).toEqual(['graph', 'orphan']);
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
});
