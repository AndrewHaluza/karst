// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { openStore } from '../../../store/db.js';
import { parkGateStage } from '../../../store/stageBlocks.js';
import { setStage } from '../../../store/stages.js';
import { createTicket } from '../../../store/tickets.js';
import { buildDashboardState } from '../state.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, blockedState, cleanupRail, go, mainLine, must, mountRail, needs, pick, q, railState, retry, seg, segEl } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

const text = (el: Element | null): string => el?.textContent ?? '';
const classes = (el: Element): string[] => [...el.classList].sort();

describe('Rail — the track', () => {
  it('renders nothing before the first snapshot', () => {
    mountRail(null);
    expect(must('#rail').childElementCount).toBe(0);
  });

  it('renders an empty lane for a ticket with no segments', () => {
    mountRail(railState({ main: [] }));
    expect(all('#rail .track > .lane')).toHaveLength(1);
    expect(all('#rail .seg')).toHaveLength(0);
  });

  it('draws one segment per stage: the current one with both name forms, the rest by key', () => {
    mountRail(railState());
    expect(all('#rail .seg').map((s) => s.className.split(' ')[1])).toEqual(['stg-scope', 'stg-impl', 'stg-uat', 'stg-review', 'stg-ship', 'stg-done']);
    const cur = segEl('impl');
    expect(text(cur.querySelector('.nm .full'))).toBe('Implementation');
    expect(text(cur.querySelector('.nm .abbr'))).toBe('impl');
    expect(text(segEl('uat').querySelector('.nm'))).toBe('uat');
    expect(segEl('uat').querySelector('.nm .full')).toBeNull();
  });

  it('puts the status in the class: needs outranks it, cur and sel ride along, an unknown status adds none', () => {
    mountRail(railState({ main: [seg('scope', { status: 'passed' }), seg('impl', { status: 'running', current: true }), seg('uat', { status: 'mystery' as never })] }));
    expect(classes(segEl('scope'))).toEqual(['passed', 'seg', 'stg-scope']);
    expect(classes(segEl('impl'))).toEqual(['cur', 'running', 'seg', 'sel', 'stg-impl']);
    expect(classes(segEl('uat'))).toEqual(['seg', 'stg-uat']);
  });

  it.each([
    ['passed', '✓'],
    ['failed', '✕'],
    ['pending', '·'],
    ['skipped', '–'],
    ['blocked', '❚❚'],
    ['bypassed', '⊘'],
  ])('draws the %s glyph %s', (status, glyph) => {
    mountRail(railState({ main: [seg('scope', { status: status as never })] }));
    expect(text(segEl('scope').querySelector('.g'))).toBe(glyph);
    expect(segEl('scope').classList.contains(status)).toBe(true);
  });

  it('draws a spinner element for a running stage and for a live retry, never for a blocked one', () => {
    mountRail(railState({ main: [seg('impl', { status: 'running' }), seg('uat', { status: 'passed', retry: retry({ live: true }) }), seg('review', { status: 'blocked' })] }));
    expect(segEl('impl').querySelector('.g > .spin[aria-hidden="true"]')).not.toBeNull();
    expect(segEl('uat').querySelector('.g > .spin')).not.toBeNull();
    expect(segEl('review').querySelector('.spin')).toBeNull();
  });

  it('says needs-you in words: the amber class, the pause glyph, the reason and the action', () => {
    mountRail(railState({ main: mainLine('ship', { ship: { status: 'pending', needsUser: true, needs: needs({ kind: 'open-session' }, { detail: 'waiting on you', action: 'Open' }) } }) }));
    const s = segEl('ship');
    expect(s.classList.contains('needs')).toBe(true);
    expect(s.classList.contains('running')).toBe(false);
    expect(text(s.querySelector('.g'))).toBe('❚❚');
    expect(text(s.querySelector('.mt'))).toBe('waiting on you');
    expect(text(go())).toBe('Open');
    expect(pick('ship').getAttribute('aria-label')).toBe('Ship: needs you');
  });

  it('draws a conflict as a warning, not as something a retry could clear', () => {
    mountRail(railState({ main: mainLine('ship', { ship: { status: 'pending', needsUser: true, needs: needs({ kind: 'resolve-panel' }, { action: 'Resolve' }) } }) }));
    expect(text(segEl('ship').querySelector('.g'))).toBe('⚠');
  });

  it('reads needs-you from the host: a needs flag on a stage that is not current shows its duration, not the wording', () => {
    mountRail(railState({ main: [seg('impl', { status: 'passed', needsUser: true, needs: needs({ kind: 'open-session' }), cell: { startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T10:05:00Z' } })] }));
    expect(text(segEl('impl').querySelector('.mt'))).toBe('5m');
    expect(q('#rail .go')).toBeNull();
  });

  it.each([
    ['2026-08-01T10:00:00Z', '2026-08-01T10:00:12.34Z', '12.3s'],
    ['2026-08-01T10:00:00Z', '2026-08-01T10:05:00Z', '5m'],
    ['2026-08-01T10:00:00Z', '2026-08-01T11:05:00Z', '1h 5m'],
  ])('shows how long a finished stage took (%s to %s: %s)', (startedAt, endedAt, want) => {
    mountRail(railState({ main: [seg('scope', { status: 'passed', cell: { startedAt, endedAt } })] }));
    expect(text(segEl('scope').querySelector('.mt'))).toBe(want);
  });

  it.each([
    ['no end', { startedAt: '2026-08-01T10:00:00Z' }],
    ['no start', { endedAt: '2026-08-01T10:00:00Z' }],
    ['end before start', { startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T09:00:00Z' }],
    ['garbage', { startedAt: 'x', endedAt: 'y' }],
  ])('shows no duration for %s', (_name, cell) => {
    mountRail(railState({ main: [seg('scope', { status: 'passed', cell })] }));
    expect(segEl('scope').querySelector('.mt')).toBeNull();
  });

  it('keeps fix off the forward path: it is drawn once, on the gate it retries, and is never a segment', () => {
    mountRail(railState({ main: mainLine('uat', { uat: { retry: retry() } }) }));
    expect(all('#rail [data-stage="fix"]')).toHaveLength(1);
    expect(q('#rail .seg.stg-fix')).toBeNull();
    expect(all('#rail .fixm')).toHaveLength(1);
    cleanupRail();
    mountRail(railState());
    expect(all('#rail .fixm')).toHaveLength(0);
  });

  it('never nests a button inside a button: the segment is a wrapper holding both controls', () => {
    mountRail(railState({ main: mainLine('uat', { uat: { needsUser: true, status: 'pending', needs: needs({ kind: 'open-session' }), retry: retry() } }) }));
    expect(all('#rail button button')).toHaveLength(0);
    expect(segEl('uat').tagName).toBe('DIV');
    expect(segEl('uat').querySelectorAll(':scope > button').length).toBe(3);
  });

  it('names the status in the accessible name, with the same string as the title', () => {
    mountRail(railState());
    expect(pick('uat').getAttribute('aria-label')).toBe('UAT: pending');
    expect(pick('uat').title).toBe('UAT: pending');
    expect(pick('impl').getAttribute('aria-label')).toBe('Implementation: running');
    expect(pick('uat').type).toBe('button');
  });
});

describe('Rail — impl approach pips', () => {
  const approach = (over: Record<string, unknown> = {}) => ({ id: 'tdd', phases: ['red', 'green', 'refactor'], reported: ['red'], ...over });
  const withApproach = (a: ReturnType<typeof approach> | null, main = mainLine('impl')) => railState({ main, approach: a });

  it('fills a pip only for a reported phase and captions the latest report with the approach', () => {
    mountRail(withApproach(approach()));
    const pips = all('#rail .seg.stg-impl .pips .p');
    expect(pips.map((p) => p.classList.contains('on'))).toEqual([true, false, false]);
    expect(pips.map((p) => p.title)).toEqual(['red — reported', 'green — not reported', 'refactor — not reported']);
    expect(text(must('#rail .pips .pn'))).toBe('red · tdd');
    expect(pick('impl').getAttribute('aria-label')).toBe('Implementation: running — approach tdd, 1 of 3 phases reported');
  });

  it('names the approach even when it declares no phases, and says nothing about a count', () => {
    mountRail(withApproach(approach({ phases: [], reported: [] })));
    expect(all('#rail .pips .p')).toHaveLength(0);
    expect(text(must('#rail .pips .pn'))).toBe('tdd');
    expect(pick('impl').getAttribute('aria-label')).toBe('Implementation: running — approach tdd');
  });

  it('counts only declared phases, so a stale mark cannot push the tally past its total', () => {
    mountRail(withApproach(approach({ reported: ['red', 'gone'] })));
    expect(pick('impl').getAttribute('aria-label')).toContain('1 of 3 phases reported');
  });

  it('draws nothing without an approach, off impl, or while impl needs the user', () => {
    mountRail(withApproach(null));
    expect(q('#rail .pips')).toBeNull();
    cleanupRail();
    mountRail(withApproach(approach(), mainLine('uat')));
    expect(q('#rail .pips')).toBeNull();
    cleanupRail();
    mountRail(withApproach(approach(), mainLine('impl', { impl: { needsUser: true, needs: needs({ kind: 'open-session' }) } })));
    expect(q('#rail .pips')).toBeNull();
    expect(q('#rail .go')).not.toBeNull();
  });
});

describe('Rail — the retry meter', () => {
  const withMeter = (over = {}) => railState({ main: mainLine('uat', { uat: { retry: retry(over) } }) });

  it('draws one tick per allowed attempt, filled per attempt spent, from the host cap', () => {
    mountRail(withMeter({ spent: 2, cap: 4 }));
    const ticks = all('#rail .fixm .tk');
    expect(ticks.map((t) => t.classList.contains('on'))).toEqual([true, true, false, false]);
    expect(text(must('#rail .fixm .tx'))).toBe('fix 2/4');
  });

  it('is a button that selects fix, labelled and titled with one string', () => {
    const h = mountRail(withMeter({ spent: 1, cap: 3, live: true, returnsTo: 'uat' }));
    const m = must('#rail .fixm');
    expect(m.tagName).toBe('BUTTON');
    expect(m.getAttribute('data-stage')).toBe('fix');
    expect(m.getAttribute('aria-label')).toBe('Fix loop on UAT: attempt 1 of 3, running');
    expect(m.title).toBe(m.getAttribute('aria-label'));
    expect(text(must('#rail .fixm .ret'))).toBe('↩ uat');
    expect(m.classList.contains('spent')).toBe(false);
    fireEvent.click(m);
    expect(h.selected).toEqual(['fix']);
  });

  it('reads as a record, not an alarm, once the loop is idle, and omits the return label when it returns where it left', () => {
    mountRail(withMeter({ live: false }));
    expect(must('#rail .fixm').classList.contains('spent')).toBe(true);
    expect(q('#rail .fixm .ret')).toBeNull();
  });

  it('puts the loop in the accessible name of the gate, return target included', () => {
    mountRail(withMeter({ spent: 1, cap: 3, live: true, returnsTo: 'review' }));
    expect(pick('uat').getAttribute('aria-label')).toBe('UAT: running — fix 1/3 running, revalidates from review');
  });

  it('appends the meter after the duration instead of choosing between them', () => {
    mountRail(railState({ main: [seg('uat', { status: 'passed', cell: { startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T10:05:00Z' }, retry: retry() })] }));
    const kids = [...segEl('uat').children].map((c) => c.className);
    expect(kids.slice(-2)).toEqual(['mt', 'fixm spent']);
  });
});

describe('Rail — selection (React owns it, the page persists it)', () => {
  const sel = (): string[] => all('#rail .pick').filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => p.dataset.stage!);

  it('defaults to the presented stage, then the current stage, then scope', () => {
    mountRail(railState({ stageCurrent: 'uat', presentedStage: 'impl' }));
    expect(sel()).toEqual(['impl']);
    cleanupRail();
    mountRail(railState({ stageCurrent: 'uat', presentedStage: '' }));
    expect(sel()).toEqual(['uat']);
    cleanupRail();
    mountRail(railState({ stageCurrent: '', presentedStage: '' }));
    expect(sel()).toEqual(['scope']);
  });

  it('starts from the selection the page persisted, and tolerates a persisted state without one', () => {
    mountRail(railState(), { persisted: { sel: 'review' } });
    expect(sel()).toEqual(['review']);
    cleanupRail();
    mountRail(railState(), { persisted: { sel: 42 } });
    expect(sel()).toEqual(['impl']);
  });

  it('selects on click at once and persists it exactly once, beside the snapshot', () => {
    const h = mountRail(railState());
    fireEvent.click(pick('uat'));
    expect(sel()).toEqual(['uat']);
    expect(segEl('uat').classList.contains('sel')).toBe(true);
    expect(h.selected).toEqual(['uat']);
    expect(h.setState).toHaveBeenCalledTimes(1);
    expect(h.setState).toHaveBeenCalledWith(expect.objectContaining({ state: railState(), sel: 'uat' }));
  });

  it('survives a state push, which must never snap the panel back to the current stage', () => {
    const h = mountRail(railState());
    fireEvent.click(pick('review'));
    h.emit({ type: 'state', state: railState({ stageCurrent: 'uat' }) });
    expect(sel()).toEqual(['review']);
  });

  it('a new ship wait selects Ship once, and the user can leave it (the page only persists it)', () => {
    const waiting = (over: Record<string, unknown> = {}) => railState({ stageCurrent: 'ship', ship: { kind: 'confirm' }, ...over });
    const h = mountRail(railState());
    h.emit({ type: 'state', state: waiting() });
    expect(sel()).toEqual(['ship']);
    expect(h.selected).toEqual(['ship']);
    fireEvent.click(pick('uat'));
    h.emit({ type: 'state', state: waiting() });
    expect(sel()).toEqual(['uat']);
  });
});

describe('Rail — layout degradation', () => {
  const widths = (scroll: (lane: HTMLElement) => number): void => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return scroll(this as HTMLElement); } });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 100; } });
  };
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  it('leaves the track alone while the lane fits', () => {
    widths(() => 100);
    mountRail(railState());
    expect(must('#rail .track').className).toBe('track');
  });

  it.each([
    [1, 'track snug'],
    [2, 'track snug tight'],
    [3, 'track snug tight bare'],
  ])('measures and drops annotations in steps (still over after %i steps: %s)', (over, want) => {
    const steps = { n: 0 };
    widths((lane) => {
      const t = lane.parentElement!;
      steps.n = ['snug', 'tight', 'bare'].filter((c) => t.classList.contains(c)).length;
      return steps.n < over ? 200 : 100;
    });
    mountRail(railState());
    expect(must('#rail .track').className).toBe(want);
  });

  it('measures again when the panel is resized', () => {
    let wide = false;
    widths(() => (wide ? 200 : 100));
    mountRail(railState());
    expect(must('#rail .track').className).toBe('track');
    wide = true;
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(must('#rail .track').classList.contains('snug')).toBe(true);
  });
});

describe('Rail — slice selection (migration plan A4)', () => {
  it('does not render again for a push whose rail is structurally unchanged, and re-renders one that changed', () => {
    const onRender = vi.fn();
    const make = (extra: Record<string, unknown> = {}) => railState({ ...extra });
    const h = mountRail(make(), { onRender });
    const before = onRender.mock.calls.length;
    h.emit({ type: 'state', state: make({ clock: 't1' }), live: true });
    h.emit({ type: 'state', state: make({ clock: 't2' }), live: true });
    expect(onRender.mock.calls.length).toBe(before);
    h.emit({ type: 'state', state: railState({ main: mainLine('impl', { uat: { retry: retry({ spent: 2 }) } }) }) });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(text(must('#rail .fixm .tx'))).toBe('fix 2/3');
  });

  it('keeps every segment the very same DOM node when one of them changes', () => {
    const h = mountRail(railState());
    const nodes = all('#rail .seg');
    h.emit({ type: 'state', state: railState({ main: mainLine('impl', { uat: { status: 'failed' } }) }) });
    expect(all('#rail .seg')).toEqual(nodes);
    expect(text(segEl('uat').querySelector('.g'))).toBe('✕');
  });
});

describe('Rail — the real host path', () => {
  it('never draws a spinner on a stage that is parked', () => {
    // store → buildDashboardState → render: parkGateStage leaves the runner's `running` in place, and the host's
    // displayStatus is what keeps the segment from claiming work is underway.
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'BLK-1', title: 'blocked at uat' });
    setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, { ticketId: t.id, stageKey: 'uat', kind: 'nothing-to-run', reason: 'no worktree resolved', runAt: '2026-08-09T10:33:42.000Z', gates: [] });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    const state = buildDashboardState(store, t.id);
    store.close();
    mountRail(state);
    expect(segEl('uat').classList.contains('blocked')).toBe(true);
    expect(all('#rail .spin')).toHaveLength(0);
  });
});

describe('Rail — a stage parked on a strip-rendering block', () => {
  it('wears the faulted class, the BLOCKED label and aria-label, with the attention glyph instead of a spinner', () => {
    mountRail(blockedState({ kind: 'boot-failed', reason: 'api down', at: '2026-08-11T14:00:00.000Z', resumable: true }));
    const cur = q('#rail .seg.cur') as HTMLElement;
    expect(cur.classList.contains('faulted')).toBe(true);
    expect(cur.querySelector('.nm .full')?.textContent).toMatch(/ · BLOCKED$/);
    expect(cur.querySelector('.pick')?.getAttribute('aria-label')).toMatch(/ blocked$/);
    expect(cur.querySelector('.g')?.textContent).toBe('⚠');
    expect(all('#rail .spin')).toHaveLength(0);
  });
  it('leaves a stage with no block untouched', () => {
    mountRail(blockedState(undefined));
    expect(all('#rail .seg.faulted')).toHaveLength(0);
  });
});
