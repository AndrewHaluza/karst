import { describe, expect, it } from 'vitest';
import { INSIDE_CASES } from './insideCases.js';
import type { InsideProcessView } from '../../model/inside/types.js';

const ids = (stage: string) => INSIDE_CASES.filter((c) => c.stage === stage).map((c) => c.id);

const stateOf = (id: string) => INSIDE_CASES.find((c) => c.stage === 'impl' && c.id === id)!.state();

/** The reducer-built graph process of one impl case. */
function graphOf(id: string) {
  const graph = stateOf(id).insideViews.impl.processes.find((p) => p.id === 'graph');
  expect(graph, `${id} graph process`).toBeDefined();
  return graph!;
}

function rowsOf(process: InsideProcessView) {
  if (process.evidence?.kind !== 'rows') throw new Error('graph evidence is not rows');
  return process.evidence;
}

const INSIDE_STAGE_KEYS = ['scope', 'impl', 'uat', 'review', 'ship', 'done'] as const;

describe('inside case registry (ui:VISUAL-VARIANTS)', () => {
  it('gives every stage pending, running and passed cases', () => {
    for (const stage of INSIDE_STAGE_KEYS) {
      for (const id of ['pending', 'running', 'passed']) expect(ids(stage), `${stage} lacks ${id}`).toContain(id);
    }
  });

  it('has unique stage/id pairs', () => {
    const keys = INSIDE_CASES.map((c) => `${c.stage}-${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(['uat', 'review'] as const)('%s has looped cases with 2+ attempts and a selected attempt', (stage) => {
    for (const id of ['fix-running', 'passed-round-2', 'older-round', 'exhausted']) {
      const c = INSIDE_CASES.find((x) => x.stage === stage && x.id === id);
      expect(c, `${stage}-${id}`).toBeDefined();
      const view = c!.state().insideViews[stage];
      expect(view.attempts?.length ?? 0, `${stage}-${id} attempts`).toBeGreaterThanOrEqual(2);
      expect(view.selectedAttempt, `${stage}-${id} selected`).toBeTruthy();
    }
  });

  it('older-round selects a non-latest attempt', () => {
    for (const stage of ['uat', 'review'] as const) {
      const v = INSIDE_CASES.find((x) => x.stage === stage && x.id === 'older-round')!.state().insideViews[stage];
      expect(v.attempts!.find((a) => a.key === v.selectedAttempt)?.latest).toBeFalsy();
    }
  });

  it('has token-pill cases for the running placeholder and the estimate mark (T1041)', () => {
    const tester = (id: string) =>
      INSIDE_CASES.find((c) => c.stage === 'uat' && c.id === id)!.state().insideViews.uat.processes.find((p) => p.id === 'tester');
    expect(tester('tokens-pending')?.tokens).toMatchObject({ state: 'pending', label: 'Σ counted at end' });
    expect(tester('tokens-estimate')?.tokens).toMatchObject({ state: 'estimated', estimateOnly: true });
  });

  it('builds the running Dynamic Graph through the reducers (T1361)', () => {
    const graph = graphOf('graph-running');
    expect(graph.status).toBe('run');
    const evidence = rowsOf(graph);
    const nodes = evidence.nodes ?? [];
    // The run header leads the ledger and carries the Stop control.
    expect(evidence.leadRows).toBe(1);
    expect(evidence.rows[0]).toMatchObject({ label: 'run 1' });
    expect(evidence.rows[0]?.action).toMatchObject({ kind: 'graph-stop' });
    // Planner + passed worker + running worker + deferred node, oldest first.
    expect(nodes.map((n) => n.nodeId)).toEqual(['planner 1', 'spec-api', 'build-ui', 'verify-e2e']);
    expect(nodes.map((n) => n.entry)).toEqual(['planner', 'node', 'node', 'deferred']);
    const passed = nodes.find((n) => n.nodeId === 'spec-api')!;
    expect(passed).toMatchObject({ displayStatus: 'pass', visit: 'visit 1/20', outcome: 'complete' });
    expect(passed.artifacts).toEqual(['api-contract · 2.8 KB', 'schema-diff · 1.4 KB']);
    const running = nodes.find((n) => n.nodeId === 'build-ui')!;
    expect(running).toMatchObject({ displayStatus: 'run', visit: 'visit 2/20', override: 'override model,effort' });
    expect(running.action).toMatchObject({ kind: 'graph-open-session' });
    expect(nodes.find((n) => n.nodeId === 'verify-e2e')).toMatchObject({ displayStatus: 'wait', status: 'deferred' });
    // The planner's own artifact rides the planner entry.
    expect(nodes.find((n) => n.entry === 'planner')?.artifacts).toEqual(['plan-rationale · 4.2 KB']);
    expect(evidence.dag?.columns.length ?? 0).toBeGreaterThan(0);
  });

  it('builds the DAG strip from graphDagView with columns, mixed glyphs and the drop count (T1361)', () => {
    const dag = rowsOf(graphOf('graph-dag')).dag;
    expect(dag).toBeDefined();
    expect(dag!.columns.length).toBe(13); // 12 kept columns (planner + depth 0..10) + the trailing uat chip
    expect(dag!.columns.some((col) => col.length > 1)).toBe(true);
    const glyphs = new Set(dag!.columns.flat().map((chip) => chip.displayStatus));
    for (const glyph of ['pass', 'run', 'wait', 'pending'] as const) expect(glyphs).toContain(glyph);
    expect(dag!.more).toMatch(/^\+\d+ more$/);
    expect(dag!.more).toBe('+2 more');
    expect(dag!.columns.at(-1)?.map((chip) => chip.id)).toEqual(['uat']);
  });

  it('parks the failed graph with the banner, the needs-you rail and recovery controls (T1361)', () => {
    const state = stateOf('graph-failed');
    expect(state.currentStage?.blocked).toMatchObject({ kind: 'approach-graph-failed', resumable: true });
    const implRail = state.rail.main.find((segment) => segment.cell.stageKey === 'impl')!;
    expect(implRail).toMatchObject({ needsUser: true, needs: { action: 'Open graph', cta: { kind: 'graph-panel' } } });
    const graph = graphOf('graph-failed');
    expect(graph.status).toBe('wait');
    const evidence = rowsOf(graph);
    expect(evidence.rows.slice(0, 3).map((r) => r.action?.kind)).toEqual(['graph-resume', 'graph-replan', 'graph-stop']);
    expect(evidence.leadRows).toBe(3);
    const blocked = (evidence.nodes ?? []).find((n) => n.nodeId === 'build-api')!;
    expect(blocked).toMatchObject({ displayStatus: 'wait', status: 'blocked', outcome: 'blocked' });
    expect(blocked.reason).toContain('TypeScript compile failed');
    expect(blocked.action).toMatchObject({ kind: 'graph-edit-override' });
    expect(evidence.rows.some((r) => r.label === 'node-blocked' && r.status === 'fail')).toBe(true);
  });
});
