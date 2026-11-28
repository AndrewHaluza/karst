// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';
import { NODE_CARD_OPEN_DELAY_MS } from './GraphNodeCard.js';

installRuntimeDoubles();
afterEach(() => {
  cleanupInside();
  vi.useRealTimers();
});

/** One process carrying `evidence`, mounted on UAT; the evidence body is always in the markup. */
const withEvidence = (evidence: unknown, over: Record<string, unknown> = {}) =>
  mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence, ...over })] }) } }));
const link = (id: string, kind = 'open-file') => ({ actionId: id, kind });

/** The host-formatted card the prerequisite ticket puts on a node run. */
const NODE_CARD = {
  title: 'ssh-runner',
  facts: [
    { label: 'Role', value: 'implement' },
    { label: 'Core', value: 'codex' },
    { label: 'Model', value: 'opus-5 · high' },
    { label: 'Ran', value: '10:01:00 → 10:19:00 (18m)' },
    { label: 'Tokens', value: '12.3k (4.1k cache read · 800 out)' },
    { label: 'Visit', value: 'visit 1/40' },
    { label: 'Output', value: 'fix.patch' },
    { label: 'Task', value: 'tasks/ssh-runner.md' },
  ],
};

describe('Evidence — the implementation graph', () => {
  const planner = {
    entry: 'planner', nodeId: 'plan', nodeKind: 'planner', status: 'done', displayStatus: 'pass', identity: 'codex', visit: 'visit 1', age: '3m', override: 'model x', outcome: 'ok', reason: 'because', artifacts: ['a.md', 'b.md'], action: link('g:1', 'graph-open-session'),
  };
  // Every detail a node row used to draw is still on the row data; the row now shows only status and age, and the
  // card carries the rest (UI-R31: the host words it).
  const node = {
    entry: 'node', nodeRunId: 1, nodeId: 'build', nodeKind: 'agent', status: 'running', displayStatus: 'run',
    identity: 'codex · opus-5 · high · implement', visit: 'visit 1/40', age: '18m',
    override: 'override model,effort', outcome: 'ok', reason: 'because it failed', artifacts: ['fix.patch'],
    action: link('g:2', 'graph-open-session'), card: NODE_CARD,
  };
  const nodes = [planner, node];
  const deferred = {
    entry: 'deferred', nodeId: 'docs', nodeKind: 'node', status: 'deferred', displayStatus: 'wait',
    identity: '', age: 'waiting 2m', reason: 'deps: web not provided',
  };
  const dag = {
    columns: [
      [{ id: 'a', label: 'a', displayStatus: 'pass', state: 'done' }],
      [{ id: 'build', label: 'build', displayStatus: 'run', state: 'running', card: NODE_CARD }, { id: 'c', label: 'c', displayStatus: 'pending', state: 'queued' }],
    ],
    more: '+2 more',
  };
  const graph = (extra: Record<string, unknown> = {}) => ({ kind: 'rows', rows: [{ label: 'row', detail: 'd', status: 'pass' }], nodes, dag, ...extra });
  const entry = (nth: number): HTMLElement => must(`.graph-nodes > .graph-entry:nth-child(${nth})`);
  const rowOf = (nth: number): HTMLElement => must('.graph-node', entry(nth));

  it('renders the host-ordered ledger with no section headers: one entry per planner run, node run or deferred node', () => {
    withEvidence(graph());
    const entries = all('.graph-nodes > .graph-entry');
    expect(entries.map((e) => text(e.querySelector('.graph-node-name')))).toEqual(['plan', 'build']);
    const first = entries[0]!;
    // The planner row is untouched: identity, visit, age, override, outcome, reason and its artifacts line.
    expect(first.querySelector('.glyph')!.getAttribute('aria-label')).toBe('passed');
    expect(text(first.querySelector('.graph-node-meta'))).toBe('planner · done');
    expect(all('.graph-node-detail > span', first).map((s) => [s.className, s.textContent])).toEqual([
      ['graph-node-identity', 'codex'], ['graph-node-visit', 'visit 1'], ['graph-node-age', '3m'], ['graph-node-override', 'model x'], ['graph-node-fact', 'ok'], ['graph-node-reason', 'because'],
    ]);
    expect(text(first.querySelector('.graph-node-artifacts'))).toBe('a.md · b.md');
    expect(text(first.querySelector('.graph-node .ev-tail button'))).toBe('Open session');
    expect(text(must('.evidence-row .ev-key'))).toBe('row');
  });

  it('makes a node row minimal: glyph, id, status, age, and only the override, reason and action that exist', () => {
    withEvidence(graph());
    const second = entry(2);
    expect(second.querySelector('.glyph')!.getAttribute('aria-label')).toBe('running');
    expect(text(second.querySelector('.graph-node-name'))).toBe('build');
    expect(text(second.querySelector('.graph-node-meta'))).toBe('running');
    // The identity, the visit, the outcome and the artifacts line left the row for the card.
    expect(second.querySelector('.graph-node-identity')).toBeNull();
    expect(second.querySelector('.graph-node-visit')).toBeNull();
    expect(second.querySelector('.graph-node-fact')).toBeNull();
    expect(second.querySelector('.graph-node-artifacts')).toBeNull();
    expect(all('.graph-node-detail > span', second).map((s) => [s.className, s.textContent])).toEqual([
      ['graph-node-age', '18m'], ['graph-node-override', 'override model,effort'], ['graph-node-reason', 'because it failed'],
    ]);
    // The action button stays; the element structure (glyph, name, meta, detail, tail) keeps the grid columns.
    expect(text(second.querySelector('.graph-node .ev-tail button'))).toBe('Open session');
    expect(all('.graph-node > *', second).map((e) => e.className)).toEqual(['glyph run', 'graph-node-name', 'graph-node-meta', 'graph-node-detail', 'ev-tail']);
  });

  it('opens one card with the host’s title and ordered facts on keyboard focus, and closes it on Escape and blur', () => {
    withEvidence(graph());
    const row = rowOf(2);
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.hasAttribute('data-node-card')).toBe(true);
    expect(row.hasAttribute('aria-describedby')).toBe(false);
    act(() => row.focus());
    const card = must('[role="tooltip"]');
    expect(all('[role="tooltip"]')).toHaveLength(1);
    expect(text(card.querySelector('.graph-card-title'))).toBe('ssh-runner');
    expect(all('dt', card).map((d) => text(d))).toEqual(NODE_CARD.facts.map((f) => f.label));
    expect(all('dd', card).map((d) => text(d))).toEqual(NODE_CARD.facts.map((f) => f.value));
    expect(row.getAttribute('aria-describedby')).toBe(card.id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(q('[role="tooltip"]')).toBeNull();
    expect(row.hasAttribute('aria-describedby')).toBe(false);
    act(() => row.blur());
    act(() => row.focus());
    expect(q('[role="tooltip"]')).not.toBeNull();
    act(() => row.blur());
    expect(q('[role="tooltip"]')).toBeNull();
  });

  it('does not open the card when the row’s action button takes focus', () => {
    withEvidence(graph());
    const row = rowOf(2);
    act(() => must('.graph-node .ev-tail button', entry(2)).focus());
    expect(q('[role="tooltip"]')).toBeNull();
    act(() => row.focus());
    expect(q('[role="tooltip"]')).not.toBeNull();
  });

  it('leaves planner and deferred rows exactly as they were, and neither is a card trigger', () => {
    withEvidence(graph({ nodes: [planner, deferred], dag: undefined }));
    const plan = entry(1);
    expect(text(plan.querySelector('.graph-node-meta'))).toBe('planner · done');
    expect(all('.graph-node-detail > span', plan).map((s) => s.className)).toEqual([
      'graph-node-identity', 'graph-node-visit', 'graph-node-age', 'graph-node-override', 'graph-node-fact', 'graph-node-reason',
    ]);
    expect(text(plan.querySelector('.graph-node-artifacts'))).toBe('a.md · b.md');
    const wait = entry(2);
    expect(text(wait.querySelector('.graph-node-meta'))).toBe('node · deferred');
    expect(all('.graph-node-detail > span', wait).map((s) => [s.className, s.textContent])).toEqual([
      ['graph-node-age', 'waiting 2m'], ['graph-node-reason', 'deps: web not provided'],
    ]);
    for (const r of [plan, wait]) {
      expect(r.querySelector('.graph-node')!.hasAttribute('data-node-card')).toBe(false);
      expect(r.querySelector('.graph-node')!.hasAttribute('tabindex')).toBe(false);
    }
    expect(q('[role="tooltip"]')).toBeNull();
  });

  it('opens a Graph view chip’s card after the hover delay and closes it when the pointer leaves', () => {
    vi.useFakeTimers();
    withEvidence(graph());
    fireEvent.click(must('[data-act="toggle-graph-view"]'));
    const chip = all('.graph-dag-chip').find((c) => c.hasAttribute('data-node-card'));
    expect(chip).toBeDefined();
    fireEvent.mouseOver(chip!);
    act(() => void vi.advanceTimersByTime(NODE_CARD_OPEN_DELAY_MS - 1));
    expect(q('[role="tooltip"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(text(must('[role="tooltip"] .graph-card-title'))).toBe('ssh-runner');
    fireEvent.mouseOut(chip!, { relatedTarget: document.body });
    expect(q('[role="tooltip"]')).toBeNull();
  });

  it('draws the leading run header rows before the ledger and the rest after it', () => {
    withEvidence({ kind: 'rows', rows: [{ label: 'run 1', detail: 'head', status: 'run' }, { label: 'log', detail: 'tail', status: 'note' }], leadRows: 1, nodes, dag });
    const order = all('.evidence-row .ev-key, .graph-nodes').map((e) => (e.classList.contains('graph-nodes') ? 'ledger' : text(e)));
    expect(order).toEqual(['run 1', 'ledger', 'log']);
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
