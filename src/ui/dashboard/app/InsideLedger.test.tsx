// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { renderStateFor } from '../renderFixtures.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

const rows = (stage: string, processes: unknown[], over: Record<string, unknown> = {}) =>
  insideState({ stageCurrent: stage, views: { [stage]: view(stage, { processes, ...over }) } });
const gatesEvidence = { kind: 'gates', rows: [{ status: 'pass', label: 'lint', detail: 'exit 0' }], passed: 1, failed: 0, skipped: 0 };
const row = (id: string) => must(`[data-proc-id="uat:${id}"]`);

describe('Ledger — rows', () => {
  it('draws one row per process in the host’s order, and the blurb only when nothing ran', () => {
    mountInside(rows('uat', [proc('gates'), proc('fix'), proc('services'), proc('tester')]));
    expect(all('.ledger [data-proc-id]').map((r) => r.dataset.procId)).toEqual(['uat:gates', 'uat:fix', 'uat:services', 'uat:tester']);
    expect(q('.blurb')).toBeNull();
  });

  it('keeps the fixture corpus’ causal order: UAT Gates, Fix, Services, Tester; Ship Commit, Push, PR, Merge', () => {
    mountInside(renderStateFor('uat'));
    const ids = all('.ledger [data-proc-id]').map((r) => r.dataset.procId);
    expect(ids.indexOf('uat:fix')).toBeGreaterThan(ids.indexOf('uat:gates'));
    expect(ids.indexOf('uat:services')).toBeGreaterThan(ids.indexOf('uat:fix'));
    expect(ids.indexOf('uat:tester')).toBeGreaterThan(ids.indexOf('uat:services'));
    cleanupInside();
    mountInside(renderStateFor('ship'));
    const ship = all('.ledger [data-proc-id]').map((r) => r.dataset.procId);
    expect(ship).toEqual(expect.arrayContaining(['ship:commit', 'ship:push', 'ship:pr', 'ship:merge']));
    expect(ship.indexOf('ship:pr')).toBeGreaterThan(ship.indexOf('ship:push'));
    expect(ship.indexOf('ship:merge')).toBeGreaterThan(ship.indexOf('ship:pr'));
  });

  it('a process with evidence is a native disclosure whose body is always in the markup', () => {
    mountInside(rows('uat', [proc('gates', { evidence: gatesEvidence })]));
    const d = row('gates');
    expect(d.tagName).toBe('DETAILS');
    expect(d.querySelector('summary > .glyph')).not.toBeNull();
    expect(d.querySelector('summary > .chev')!.getAttribute('aria-hidden')).toBe('true');
    expect(d.querySelector('.op-body .gates')).not.toBeNull();
    expect((d as HTMLDetailsElement).open).toBe(false);
  });

  it('one with nothing behind it states its fact and offers no disclosure it cannot honour', () => {
    mountInside(rows('uat', [proc('fix', { detail: 'nothing to fix' })]));
    const d = row('fix');
    expect(d.classList.contains('op-static')).toBe(true);
    expect(d.parentElement!.classList.contains('op')).toBe(true);
    expect(q('summary')).toBeNull();
    expect(q('.chev')).toBeNull();
    expect(text(d.querySelector('.op-detail-text'))).toBe('nothing to fix');
  });

  it('orders status, name, detail, then the right-hand cluster, and the disclosure marker last', () => {
    mountInside(rows('uat', [proc('gates', { evidence: gatesEvidence })]));
    expect([...must('[data-proc-id] > summary').children].map((c) => c.className.split(' ')[0])).toEqual(['glyph', 'op-name', 'op-detail', 'op-tail', 'chev']);
  });

  it('puts the status on the glyph (its word as the accessible name), never as text in the tail', () => {
    mountInside(rows('uat', [proc('a', { status: 'pass' }), proc('b', { status: 'fail' }), proc('c', { status: 'wait' }), proc('d', { status: 'run' }), proc('e', { status: 'skip' }), proc('f', { status: 'note' }), proc('g', { status: 'pending' })]));
    const names = all('.ledger .glyph').map((g) => [g.className, g.getAttribute('aria-label')]);
    expect(names).toEqual([
      ['glyph pass', 'passed'],
      ['glyph fail', 'failed'],
      ['glyph wait', 'waiting'],
      ['glyph run', 'running'],
      ['glyph skip', 'skipped'],
      ['glyph note', 'note'],
      ['glyph pending', 'pending'],
    ]);
    expect(all('.op-tail').every((t) => !/passed|failed|running|waiting/.test(t.textContent ?? ''))).toBe(true);
  });

  it('prefers the host’s own status label over the closed word', () => {
    mountInside(rows('uat', [proc('a', { status: 'fail', statusLabel: 'blocked on quota' })]));
    expect(must('.ledger .glyph').getAttribute('aria-label')).toBe('blocked on quota');
  });

  it('colours the detail by status and marks a running, failed or waiting source row', () => {
    mountInside(rows('uat', [proc('a', { status: 'run', evidence: gatesEvidence }), proc('b', { status: 'fail', evidence: gatesEvidence }), proc('c', { status: 'wait', evidence: gatesEvidence }), proc('d', { status: 'pass', evidence: gatesEvidence })]));
    expect(all('.ledger > details').map((d) => [...d.classList].sort().join(' '))).toEqual(['live op run', 'fail failed-source op', 'op wait waiting-source', 'op pass']);
    expect(row('b').querySelector('.op-detail')!.classList.contains('fail')).toBe(true);
  });

  it('names the process with a title and an AI mark only when an agent ran or is configured to', () => {
    const x = { provider: 'claude', providerLabel: 'Claude Code', model: 'm', modelLabel: 'Model A' };
    mountInside(rows('uat', [proc('a', { label: 'Tester' }), proc('b', { execution: x }), proc('c', { configuredExecution: x })]));
    expect(all('.op-name').map((n) => n.title)).toEqual(['Tester', 'B', 'C']);
    expect(all('.op-name').map((n) => n.querySelector('.ai-mark') !== null)).toEqual([false, true, true]);
  });

  it('renders the identity a row is entitled to: what ran, else what is configured, else the host’s note', () => {
    const ran = { provider: 'claude', providerLabel: 'Claude Code', model: 'm', modelLabel: 'Model A', agentName: 'bob' };
    const cfg = { provider: 'codex', providerLabel: 'Codex', model: 'g', modelLabel: 'Model B' };
    mountInside(rows('uat', [proc('a', { execution: ran, configuredExecution: cfg }), proc('b', { configuredExecution: cfg }), proc('c', { identityNote: 'no agent configured' }), proc('d')]));
    const tails = all('.op-tail');
    expect(text(tails[0]!.querySelector('.agent-core'))).toBe('Claude Code');
    expect(tails[0]!.textContent).not.toContain('Codex');
    expect(text(tails[0]!.querySelector('.agent-name'))).toBe('bob');
    expect(text(tails[1]!.querySelector('.agent-core'))).toBe('Codex');
    expect(text(tails[1]!.querySelector('.agent-model'))).toBe('Model B');
    expect(text(tails[2]!.querySelector('.identity-note'))).toBe('no agent configured');
    expect(tails[3]!.querySelector('.agent-id, .identity-note')).toBeNull();
  });

  it('draws the provider mark from the injected identity runtime, and degrades to text when it has none', () => {
    const g = globalThis as unknown as { agentIconHtml?: (p: string) => string };
    g.agentIconHtml = (p) => (p === 'claude' ? '<span class="agenticon" aria-hidden="true"><svg></svg></span>' : '');
    try {
      const x = (provider: string) => ({ provider, providerLabel: provider, model: null, modelLabel: '' });
      mountInside(rows('uat', [proc('a', { execution: x('claude') }), proc('b', { execution: x('other') })]));
      const ids = all('.agent-id');
      expect(ids[0]!.querySelector('.agenticon svg')).not.toBeNull();
      expect(ids[1]!.querySelector('.agenticon')).toBeNull();
    } finally {
      delete g.agentIconHtml;
    }
  });

  it('places aggregate, count, time and duration in the tail, each only when stated, with the exact span as a title', () => {
    mountInside(rows('uat', [proc('a', { aggregate: '4 passed · 1 failed', aggregateTitle: 'by gate', count: '5 rows', time: '10:00', duration: '12s', durationExact: '12.4s' }), proc('b')]));
    const tail = all('.op-tail')[0]!;
    expect(all('.count', tail).map((c) => c.textContent)).toEqual(['4 passed · 1 failed', '5 rows']);
    expect(all('.count', tail)[0]!.title).toBe('by gate');
    expect(all('.count', tail)[1]!.hasAttribute('title')).toBe(false);
    expect(text(tail.querySelector('.op-time'))).toBe('10:00');
    expect(tail.querySelector('.duration')!.getAttribute('title')).toBe('12.4s');
    expect([...tail.children].map((c) => c.className.split(' ')[0])).toEqual(['count', 'count', 'op-time', 'duration']);
    expect(all('.op-tail')[1]!.childElementCount).toBe(0);
  });

  it('shows the Σ pill: fresh tokens with their exact title, cache reads beside it, live while running', () => {
    mountInside(
      rows('uat', [
        proc('a', { status: 'run', tokens: { state: 'measured', total: '12.4k', exact: '12,435', cacheRead: '1.2M', cacheReadExact: '1,234,567' } }),
        proc('b', { tokens: { state: 'estimated', total: '800' } }),
      ]),
    );
    const [a, b] = all('.token-stat');
    expect(a!.classList.contains('live')).toBe(true);
    expect(a!.title).toBe('12,435 fresh tokens');
    expect(a!.firstElementChild!.className).toBe('sigma');
    expect(a!.textContent).toBe('Σ12.4k tok+1.2M cached');
    expect(a!.querySelector('.cache-read')!.getAttribute('title')).toBe('1,234,567 tokens re-read from the prompt cache');
    expect(b!.classList.contains('live')).toBe(false);
    expect(b!.textContent).toBe('Σ800 tok');
    expect(b!.hasAttribute('title')).toBe(false);
  });

  it('renders unavailable usage as a titled absence, never as zero', () => {
    mountInside(rows('uat', [proc('a', { tokens: { state: 'unavailable', title: 'this provider reports no usage' } })]));
    const t = must('.token-stat');
    expect(t.textContent).toBe('usage unavailable');
    expect(t.title).toBe('this provider reports no usage');
  });

  it('renders every host string as text, never as markup (UI-R32)', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    mountInside(rows('uat', [proc('a', { label: hostile, detail: hostile, evidence: { kind: 'rows', rows: [{ label: hostile, detail: hostile }] } })]));
    expect(document.querySelectorAll('#inside script, #inside img').length).toBe(0);
    expect(row('a').textContent).toContain(hostile);
  });
});

describe('Ledger — the action button', () => {
  const withAction = (action: Record<string, unknown>) => rows('uat', [proc('a', { action })]);
  const button = () => must<HTMLButtonElement>('.op-tail [data-act="inside-action"]');

  it('labels it from the closed vocabulary, or with the host’s count-bearing label verbatim', () => {
    mountInside(withAction({ actionId: 'x:1', kind: 'open-full-evidence' }));
    expect(text(button())).toBe('Show all');
    expect(button().title).toBe('Show every recorded row');
    expect(button().className).toBe('k-btn k-btn--secondary k-btn--sm');
    cleanupInside();
    mountInside(withAction({ actionId: 'x:1', kind: 'open-full-evidence', label: 'Show 14 more' }));
    expect(text(button())).toBe('Show 14 more');
  });

  it('draws an irreversible control as the danger variant, and the override edit as an ordinary one', () => {
    mountInside(withAction({ actionId: 'x:1', kind: 'graph-discard-node' }));
    expect(button().classList.contains('k-btn--danger')).toBe(true);
    expect(button().title).toBe('Discard unknown process — it may still be running');
    cleanupInside();
    mountInside(withAction({ actionId: 'x:1', kind: 'graph-edit-override' }));
    expect(button().classList.contains('k-btn--danger')).toBe(false);
    expect(text(button())).toBe('Edit override');
  });

  it('renders nothing for a kind outside the vocabulary', () => {
    mountInside(withAction({ actionId: 'x:1', kind: 'from-the-future' }));
    expect(q('[data-act="inside-action"]')).toBeNull();
  });

  it('posts the opaque action id with a request id once, goes pending and keeps its className', () => {
    const h = mountInside(withAction({ actionId: 'x:1', kind: 'retry-ship-repo' }));
    const cls = button().className;
    fireEvent.click(button());
    fireEvent.click(button());
    expect(h.send.insideAction.mock.calls).toEqual([['x:1', expect.any(String)]]);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect([...button().classList].filter((c) => c !== 'is-pending').join(' ')).toBe(cls);
    h.emit({ type: 'state', state: withAction({ actionId: 'x:1', kind: 'retry-ship-repo' }), live: true } as HostMessage);
    expect(button().getAttribute('aria-busy')).toBe('true');
  });

  it('does not toggle the disclosure it sits in', () => {
    mountInside(rows('uat', [proc('a', { evidence: gatesEvidence, action: { actionId: 'x:1', kind: 'resume-stage' } })]));
    const d = row('a') as HTMLDetailsElement;
    expect(fireEvent.click(button())).toBe(false);
    expect(d.open).toBe(false);
  });
});

describe('Ledger — disclosure memory', () => {
  const open = (id: string) => (row(id) as HTMLDetailsElement).open;
  const toggle = (id: string, value: boolean) => {
    const d = row(id) as HTMLDetailsElement;
    d.open = value;
    fireEvent(d, new Event('toggle'));
  };
  const session = { kind: 'timeline', rows: [{ label: 'start', status: 'pass' }] };

  it('opens the session on first render and nothing else but a running process', () => {
    mountInside(
      rows('uat', [
        proc('session', { kind: 'session', evidence: session }),
        proc('gates', { kind: 'gates', evidence: gatesEvidence }),
        proc('findings', { kind: 'review', evidence: { kind: 'findings', rows: [{ label: 'high', detail: 'x' }], blocking: 0 } }),
        proc('prs', { kind: 'pr', evidence: { kind: 'prs', rows: [{ label: 'a' }], open: 1, merged: 0 } }),
        proc('live', { kind: 'gates', status: 'run', evidence: gatesEvidence }),
        proc('bare', { kind: 'session' }),
      ]),
    );
    expect(['session', 'gates', 'findings', 'prs', 'live'].map(open)).toEqual([true, false, false, false, true]);
    expect(q('[data-proc-id="uat:bare"]')!.tagName).toBe('DIV');
  });

  it('keeps a row the user opened open across a push, and one they closed closed (even a default-open one)', () => {
    const state = () => rows('uat', [proc('session', { kind: 'session', evidence: session }), proc('gates', { kind: 'gates', evidence: gatesEvidence })]);
    const h = mountInside(state());
    toggle('gates', true);
    toggle('session', false);
    h.emit({ type: 'state', state: state() } as HostMessage);
    h.emit({ type: 'state', state: state(), live: true } as HostMessage);
    expect([open('gates'), open('session')]).toEqual([true, false]);
  });

  it('survives a visit to another stage and back', () => {
    const state = insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('gates', { kind: 'gates', evidence: gatesEvidence })] }) } });
    const h = mountInside(state, { withRail: true });
    toggle('gates', true);
    h.emit({ type: 'state', state: { ...state, presentedStage: 'uat' } } as HostMessage);
    expect(open('gates')).toBe(true);
  });

  it('a running row that settles closes itself unless the user touched it', () => {
    const h = mountInside(rows('uat', [proc('gates', { kind: 'gates', status: 'run', evidence: gatesEvidence })]));
    expect(open('gates')).toBe(true);
    h.emit({ type: 'state', state: rows('uat', [proc('gates', { kind: 'gates', status: 'pass', evidence: gatesEvidence })]) } as HostMessage);
    expect(open('gates')).toBe(false);
  });
});

describe('Ledger — the delivery receipt and the footer', () => {
  const receipt = (hero: unknown) => ({ kind: 'receipt', rows: [{ label: 'PR', detail: '#12', status: 'pass' }], hero, blocks: [{ label: 'Delivered', value: '1', details: [] }] });

  it('a receipt with a hero is its own body: no summary row, no disclosure around the overview', () => {
    mountInside(rows('done', [proc('delivery-receipt', { evidence: receipt({ title: 'Delivered', summary: '1 PR merged', time: '10:00' }) })]));
    const body = must('.ledger > .op-body.receipt-body');
    expect(body.dataset.procId).toBe('done:delivery-receipt');
    expect(q('.ledger > details')).toBeNull();
    expect(q('.ledger .op-static')).toBeNull();
    expect(body.querySelector('.done-hero')).not.toBeNull();
    expect(body.querySelector('details.done-details')).not.toBeNull();
  });

  it('a receipt with no hero keeps its summary row, the body beneath it', () => {
    mountInside(rows('done', [proc('delivery-receipt', { detail: 'nothing delivered yet', evidence: receipt(undefined) })]));
    const [summary, body] = [...must('.ledger').children];
    expect(summary!.className).toBe('op op-static');
    expect(summary!.lastElementChild!.tagName).toBe('SPAN');
    expect(body!.className).toBe('op-body receipt-body');
  });

  it('draws the footer facts, the last as the rule, and a footer alone makes the row a disclosure', () => {
    mountInside(rows('uat', [proc('s', { footer: ['a', 'b', 'c'] })]));
    expect(row('s').tagName).toBe('DETAILS');
    const spans = all('.session-foot > span');
    expect(spans.map((s) => s.textContent)).toEqual(['a', 'b', 'c']);
    expect(spans.map((s) => s.className)).toEqual(['', '', 'session-rule']);
  });
});

describe('Ledger — the console button', () => {
  const flagged = (over: Record<string, unknown>, viewOver: Record<string, unknown> = {}) =>
    rows('uat', [proc('gates', { evidence: gatesEvidence }), proc('tester', { evidence: gatesEvidence, ...over })], viewOver);
  const btn = (sel = '[data-act="console"]') => all<HTMLButtonElement>(sel);

  it('sits in the GATES row’s description area, icon-only, only for a stage the host flags', () => {
    mountInside(flagged({}, { console: true }));
    const [b] = btn();
    expect(btn()).toHaveLength(1);
    expect(b!.closest('.op-detail')!.classList.contains('detail-console')).toBe(true);
    expect(b!.closest('summary')).not.toBeNull();
    expect(b!.className).toBe('k-iconbtn ib t-open');
    expect(b!.querySelector('svg.k-icon')).not.toBeNull();
    expect(b!.textContent).toBe('');
    expect(b!.getAttribute('aria-label')).toBe("View this stage's console output in the dashboard");
    expect(b!.title).toBe(b!.getAttribute('aria-label'));
    expect(b!.dataset.console).toBe('uat');
    expect(b!.hasAttribute('data-console-proc')).toBe(false);
    expect(b!.hasAttribute('data-stage')).toBe(false);
    cleanupInside();
    mountInside(flagged({}));
    expect(btn()).toHaveLength(0);
  });

  it('offers a gate-lane AI process its OWN console when the host flags it, whatever the stage says', () => {
    mountInside(flagged({ console: true }));
    const [b] = btn();
    expect(btn()).toHaveLength(1);
    expect(b!.dataset.console).toBe('uat');
    expect(b!.dataset.consoleProc).toBe('tester');
    expect(b!.getAttribute('aria-label')).toBe("View this process's console output in the dashboard");
    expect(row('tester').contains(b!)).toBe(true);
  });

  it('asks the page to open the stage console, or the process console, and does not toggle the row', () => {
    const h = mountInside(flagged({ console: true }, { console: true }));
    const [stage, process] = btn();
    expect(fireEvent.click(stage!)).toBe(false);
    expect((row('gates') as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(process!);
    expect(h.terminals).toEqual([
      { stage: 'uat', processId: null },
      { stage: 'uat', processId: 'tester' },
    ]);
    expect(h.send.insideAction).not.toHaveBeenCalled();
  });
});

describe('Ledger — live overlays', () => {
  it('replaces the snapshot row with a completed one, keeping the evidence the event does not carry', () => {
    const state = rows('uat', [proc('gates', { status: 'run', evidence: gatesEvidence })]);
    const h = mountInside(state);
    h.emit({ type: 'inside-progress', event: { kind: 'completed', ticketId: 1, stage: 'uat', process: proc('gates', { status: 'fail', detail: 'lint failed' }) } } as HostMessage);
    expect(row('gates').querySelector('.glyph')!.className).toBe('glyph fail');
    expect(text(row('gates').querySelector('.op-detail-text'))).toBe('lint failed');
    expect(row('gates').querySelector('.gates')).not.toBeNull();
  });

  it('appends a completed row the snapshot does not know yet, then lets the snapshot retire it', () => {
    const h = mountInside(rows('uat', [proc('gates')]));
    h.emit({ type: 'inside-progress', event: { kind: 'completed', ticketId: 1, stage: 'uat', process: proc('extra') } } as HostMessage);
    expect(all('.ledger [data-proc-id]').map((r) => r.dataset.procId)).toEqual(['uat:gates', 'uat:extra']);
    h.emit({ type: 'state', state: rows('uat', [proc('gates'), proc('extra', { detail: 'from the snapshot' })]) } as HostMessage);
    expect(text(row('extra').querySelector('.op-detail-text'))).toBe('from the snapshot');
  });

  it('draws a waiting live operation without a running spinner', () => {
    mountInside(rows('uat', [proc('gates')], { live: { status: 'wait', label: 'parked' } }));
    expect(must('.inside-live .glyph').className).toBe('glyph wait');
    expect(q('.inside-live .glyph.run')).toBeNull();
  });
});
