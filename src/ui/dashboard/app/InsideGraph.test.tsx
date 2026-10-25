// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

/** One process carrying `evidence`, mounted on UAT; the evidence body is always in the markup. */
const withEvidence = (evidence: unknown, over: Record<string, unknown> = {}) =>
  mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence, ...over })] }) } }));
const link = (id: string, kind = 'open-file') => ({ actionId: id, kind });

describe('Evidence — the implementation graph', () => {
  const nodes = [
    { entry: 'planner', nodeId: 'plan', nodeKind: 'planner', status: 'done', displayStatus: 'pass', identity: 'codex', visit: 'visit 1', age: '3m', override: 'model x', outcome: 'ok', reason: 'because', artifacts: ['a.md', 'b.md'], action: link('g:1', 'graph-open-session') },
    { entry: 'node', nodeRunId: 1, nodeId: 'build', nodeKind: 'agent', status: 'running', displayStatus: 'run', identity: 'codex' },
  ];
  const dag = { columns: [[{ id: 'a', label: 'a', displayStatus: 'pass', state: 'done' }], [{ id: 'build', label: 'build', displayStatus: 'run', state: 'running' }, { id: 'c', label: 'c', displayStatus: 'pending', state: 'queued' }]], more: '+2 more' };
  const graph = (extra: Record<string, unknown> = {}) => ({ kind: 'rows', rows: [{ label: 'row', detail: 'd', status: 'pass' }], nodes, dag, ...extra });

  it('renders the host-ordered ledger with no section headers: one entry per planner run, node run or deferred node', () => {
    withEvidence(graph());
    const entries = all('.graph-nodes > .graph-entry');
    expect(entries.map((e) => text(e.querySelector('.graph-node-name')))).toEqual(['plan', 'build']);
    const first = entries[0]!;
    expect(first.querySelector('.glyph')!.getAttribute('aria-label')).toBe('passed');
    expect(text(first.querySelector('.graph-node-meta'))).toBe('planner · done');
    expect(all('.graph-node-detail > span', first).map((s) => [s.className, s.textContent])).toEqual([
      ['graph-node-identity', 'codex'], ['graph-node-visit', 'visit 1'], ['graph-node-age', '3m'], ['graph-node-override', 'model x'], ['graph-node-fact', 'ok'], ['graph-node-reason', 'because'],
    ]);
    expect(text(first.querySelector('.graph-node-artifacts'))).toBe('a.md · b.md');
    expect(text(first.querySelector('.graph-node .ev-tail button'))).toBe('Open session');
    expect(entries[1]!.querySelector('.graph-node-artifacts')).toBeNull();
    expect(text(must('.evidence-row .ev-key'))).toBe('row');
  });

  it('offers the DAG switch only when the host shipped columns, local to the ticket and kept across pushes', () => {
    const h = mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence: graph() })] }) } }));
    const toggle = () => must<HTMLButtonElement>('[data-act="toggle-graph-view"]');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(q('.graph-dag')).toBeNull();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(q('.graph-nodes')).toBeNull();
    expect(h.send.insideAction).not.toHaveBeenCalled();
    const strip = must('.graph-dag');
    expect(strip.getAttribute('role')).toBe('group');
    expect(strip.getAttribute('aria-label')).toBe('Implementation graph');
    expect(strip.getAttribute('tabindex')).toBe('0');
    expect(all('.graph-dag-col').map((c) => all('.graph-dag-id', c).map((i) => i.textContent))).toEqual([['a'], ['build', 'c']]);
    expect(all('.graph-dag-link')).toHaveLength(1);
    expect(all('.graph-dag-chip').map((c) => c.className)).toEqual(['graph-dag-chip pass', 'graph-dag-chip run', 'graph-dag-chip pending']);
    expect(text(must('.graph-dag-more'))).toBe('+2 more');
    h.emit({ type: 'state', state: insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence: graph() })] }) } }) } as never);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    expect(q('.graph-dag')).toBeNull();
    expect(q('.graph-nodes')).not.toBeNull();
  });

  it('keeps one ticket’s choice from leaking into another’s', () => {
    const state = (ticketId: number) => ({ ...insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence: graph() })] }) } }), ticketId });
    const h = mountInside(state(1));
    fireEvent.click(must('[data-act="toggle-graph-view"]'));
    expect(q('.graph-dag')).not.toBeNull();
    h.emit({ type: 'state', state: state(2) } as never);
    expect(q('.graph-dag')).toBeNull();
    expect(must('[data-act="toggle-graph-view"]').getAttribute('aria-pressed')).toBe('false');
    h.emit({ type: 'state', state: state(1) } as never);
    expect(q('.graph-dag')).not.toBeNull();
  });

  it('draws no switch without columns, and no ledger without nodes', () => {
    withEvidence(graph({ dag: undefined }));
    expect(q('[data-act="toggle-graph-view"]')).toBeNull();
    expect(q('.graph-nodes')).not.toBeNull();
    cleanupInside();
    withEvidence(graph({ nodes: [] }));
    expect(q('.graph-nodes')).toBeNull();
    expect(q('[data-act="toggle-graph-view"]')).toBeNull();
  });
});
