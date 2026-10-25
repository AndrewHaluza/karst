// @vitest-environment jsdom
/**
 * Migration plan A4: the host re-sends the whole snapshot every second while work runs. A push that only advanced a
 * clock or a token count must render the clock and token leaves and NOTHING else: not the ledger, not the evidence,
 * not the graph. `statusWord` is called by every structural part that draws a status (the rows, the live header, the
 * evidence glyphs, the graph nodes) and by no leaf, so its call count is the render counter for the structure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, text, view } from './fixtures/insideKit.js';

const structural = vi.hoisted(() => ({ renders: 0 }));
vi.mock('./insideText.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./insideText.js')>();
  return {
    ...real,
    statusWord: (status: string | undefined) => {
      structural.renders += 1;
      return real.statusWord(status);
    },
  };
});

installRuntimeDoubles();
afterEach(cleanupInside);

const nodes = [{ entry: 'node', nodeRunId: 1, nodeId: 'build', nodeKind: 'agent', status: 'running', displayStatus: 'run', identity: 'codex', age: '1m' }];
const tokens = (total: string, exact: string) => ({ state: 'measured', total, exact });

/** A running stage whose every ticking fact is parameterised by `n`. */
function at(n: number, over: { readonly structure?: string } = {}): DashboardState {
  return insideState({
    stageCurrent: 'impl',
    views: {
      impl: view('impl', {
        clock: `started 09:12 · ${n}s elapsed`,
        live: { status: 'run', label: 'session', detail: over.structure ?? 'working', duration: `${n}s` },
        processes: [
          proc('session', {
            kind: 'session',
            status: 'run',
            time: '09:12',
            duration: `${n}s`,
            durationExact: `${n}.0s`,
            tokens: tokens(`${n}k`, `${n},000`),
            action: { actionId: 'a:1', kind: 'open-full-evidence' },
            evidence: {
              kind: 'timeline',
              rows: [
                { label: 'Claude Code', role: 'identity', provider: 'claude', detail: 'Claude Code', duration: `${n}s`, time: '09:12', tokens: tokens(`${n}k`, `${n},000`), status: 'run' },
                { label: 'Plan', status: 'pass', detail: 'accepted', duration: '2s' },
              ],
            },
          }),
          proc('graph', {
            kind: 'graph',
            status: 'run',
            duration: `${n}s`,
            evidence: { kind: 'rows', rows: [{ label: 'step', status: 'run', detail: 'building', duration: `${n}s` }], nodes: nodes.map((x) => ({ ...x, age: `${n}m` })) },
          }),
          proc('gates', { kind: 'gates', status: 'pass', evidence: { kind: 'gates', rows: [{ label: 'lint', status: 'pass', duration: '1s' }], passed: 1, failed: 0, skipped: 0 } }),
        ],
      }),
    },
  });
}

const push = (h: ReturnType<typeof mountInside>, state: DashboardState, extra: Record<string, unknown> = {}): void =>
  h.emit({ type: 'state', state, ...extra } as HostMessage);

describe('a live push re-renders only the clock and token leaves (A4)', () => {
  it('advances every ticking fact without rendering the ledger, the evidence or the graph', () => {
    const h = mountInside(at(1));
    expect(text(must('.inside-meta'))).toBe('started 09:12 · 1s elapsed');
    const settled = structural.renders;
    expect(settled).toBeGreaterThan(0);

    push(h, at(2), { live: true, settlesActions: false });
    expect(structural.renders).toBe(settled);
    expect(text(must('.inside-meta'))).toBe('started 09:12 · 2s elapsed');
    expect(text(must('.inside-live .duration'))).toBe('2s');
    expect(text(must('[data-proc-id="impl:session"] > summary .duration'))).toBe('2s');
    expect(must('[data-proc-id="impl:session"] > summary .duration').getAttribute('title')).toBe('2.0s');
    expect(text(must('[data-proc-id="impl:session"] > summary .token-stat'))).toBe('Σ2k tok');
    expect(must('[data-proc-id="impl:session"] > summary .token-stat').getAttribute('title')).toBe('2,000 fresh tokens');
    expect(text(must('.timeline-tail .token-stat'))).toBe('Σ2k tok');

    push(h, at(3), { live: true });
    expect(structural.renders).toBe(settled);
    expect(text(must('.inside-meta'))).toBe('started 09:12 · 3s elapsed');
  });

  it('keeps every row, disclosure and control the very same node, and never moves focus', () => {
    const h = mountInside(at(1));
    const session = must<HTMLDetailsElement>('[data-proc-id="impl:session"]');
    const body = must('.session-segments');
    const button = must<HTMLButtonElement>('[data-proc-id="impl:session"] [data-act="inside-action"]');
    button.focus();
    session.open = false;
    session.dispatchEvent(new Event('toggle'));
    push(h, at(2), { live: true });
    push(h, at(3), { live: true });
    expect(must('[data-proc-id="impl:session"]')).toBe(session);
    expect(must('.session-segments')).toBe(body);
    expect(session.open).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('touches nothing in the DOM but the leaves’ own text', () => {
    const h = mountInside(at(1));
    const leaves = '.inside-meta, .inside-live .duration, [data-proc-id] > summary .duration, [data-proc-id] > summary .token-stat, .timeline-tail .token-stat';
    const changed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) changed.push(r.target);
    });
    observer.observe(must('#inside'), { subtree: true, childList: true, characterData: true, attributes: true });
    push(h, at(2), { live: true });
    const records = observer.takeRecords();
    changed.push(...records.map((r) => r.target));
    observer.disconnect();
    expect(changed.length).toBeGreaterThan(0);
    for (const node of changed) {
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement!;
      expect(el.closest(leaves), `${el.outerHTML.slice(0, 80)} changed on a clock-only push`).not.toBeNull();
    }
  });

  it('applies a clocks repaint the same way', () => {
    const h = mountInside(at(1));
    const settled = structural.renders;
    h.emit({ type: 'clocks', clocks: { impl: { clock: 'started 09:12 · 7s elapsed', live: '7s', processes: { session: { time: '09:12', duration: '7s', durationExact: '7.0s' } } } } } as HostMessage);
    expect(structural.renders).toBe(settled);
    expect(text(must('.inside-meta'))).toBe('started 09:12 · 7s elapsed');
    expect(text(must('.inside-live .duration'))).toBe('7s');
    expect(text(must('[data-proc-id="impl:session"] > summary .duration'))).toBe('7s');
  });

  it('does render the structure when something other than a clock moved (the counter is not vacuous)', () => {
    const h = mountInside(at(1));
    const settled = structural.renders;
    push(h, at(2, { structure: 'now waiting on the host' }), { live: true });
    expect(structural.renders).toBeGreaterThan(settled);
    expect(text(must('.live-copy'))).toBe('now waiting on the host');
  });

  it('re-renders only the rows that changed when the structure does', () => {
    const h = mountInside(at(1));
    const next = at(1);
    const procs = (next.insideViews as unknown as Record<string, { processes: Array<Record<string, unknown>> }>).impl!.processes;
    procs[2] = { ...procs[2]!, detail: 'all green' };
    const gates = must('[data-proc-id="impl:gates"]');
    const session = must('[data-proc-id="impl:session"]');
    push(h, next);
    expect(must('[data-proc-id="impl:gates"]')).toBe(gates);
    expect(text(gates.querySelector('.op-detail-text'))).toBe('all green');
    expect(must('[data-proc-id="impl:session"]')).toBe(session);
  });

  it('shows a clock or duration that appears or disappears, from the leaf alone', () => {
    const h = mountInside(at(1));
    const bare = at(1);
    const v = (bare.insideViews as unknown as Record<string, { live: Record<string, unknown>; processes: Array<Record<string, unknown>> }>).impl!;
    delete v.live.duration;
    delete v.processes[0]!.time;
    delete v.processes[0]!.duration;
    delete v.processes[0]!.tokens;
    const settled = structural.renders;
    push(h, bare, { live: true });
    expect(structural.renders).toBe(settled);
    expect(all('.inside-live .duration')).toHaveLength(0);
    // Only the detail's separator remains: the duration's went with it.
    expect(all('.inside-live .sep')).toHaveLength(1);
    expect(all('[data-proc-id="impl:session"] > summary .duration, [data-proc-id="impl:session"] > summary .op-time, [data-proc-id="impl:session"] > summary .token-stat')).toHaveLength(0);
    push(h, at(5), { live: true });
    expect(text(must('.inside-live .duration'))).toBe('5s');
    expect(all('.inside-live .sep')).toHaveLength(2);
  });
});
