// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

describe('Inside — the shell', () => {
  it('renders nothing before the first snapshot', () => {
    mountInside(null);
    expect(must('#inside').childElementCount).toBe(0);
  });

  it('renders nothing for a stage the snapshot has no view for', () => {
    mountInside(insideState({ stageCurrent: 'closed', presentedStage: 'closed' }));
    expect(must('#inside').childElementCount).toBe(0);
  });

  it('draws the block for the ticket’s own stage: title, header clock, and the blurb when nothing ran', () => {
    mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { title: 'UAT', clock: 'has not run yet', blurb: 'Runs the tests.' }) } }));
    const section = must('#inside > section.inside');
    expect(section.getAttribute('aria-labelledby')).toBe('inside-title');
    expect(section.classList.contains('viewing')).toBe(false);
    expect(must('.inside-head').getAttribute('title')).toBe('UAT');
    expect(text(must('#inside-title'))).toBe('Inside uat');
    expect(text(must('.inside-meta'))).toBe('has not run yet');
    expect(text(must('.blurb'))).toBe('Runs the tests.');
    expect(q('.ledger')).toBeNull();
    expect(q('.vbar')).toBeNull();
  });

  it('falls back from the presented stage to the current one to scope', () => {
    mountInside(insideState({ stageCurrent: 'uat', presentedStage: 'review' }));
    expect(text(must('#inside-title'))).toBe('Inside review');
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', presentedStage: '' }));
    expect(text(must('#inside-title'))).toBe('Inside uat');
    cleanupInside();
    mountInside(insideState({ stageCurrent: '', presentedStage: '' }));
    expect(text(must('#inside-title'))).toBe('Inside scope');
  });

  it('renders the view the persisted selection names, with the viewing bar and a Back that follows the ticket again', () => {
    const h = mountInside(insideState({ stageCurrent: 'impl', views: { scope: view('scope', { title: 'Scope' }) } }), { persisted: { sel: 'scope' } });
    expect(text(must('#inside-title'))).toBe('Inside scope');
    expect(must('#inside > section.inside').classList.contains('viewing')).toBe(true);
    expect(text(must('.vbar > span'))).toBe('Viewing Scope — not the current stage.');
    const back = must<HTMLButtonElement>('.vbar [data-back]');
    expect(text(back)).toBe('Back to Implementation');
    expect(back.getAttribute('title')).toBe('Return the strip to the stage the ticket is actually on');
    fireEvent.click(back);
    expect(text(must('#inside-title'))).toBe('Inside impl');
    expect(q('.vbar')).toBeNull();
    expect(h.persisted).toEqual([{ sel: null, shipWait: null }]);
  });

  it('never shows a viewing bar when the ticket has no current stage (every stage is equally uncurrent)', () => {
    mountInside(insideState({ stageCurrent: '', presentedStage: 'uat' }));
    expect(q('.vbar')).toBeNull();
  });

  it('keeps the selection across a snapshot, a live repaint and a clocks repaint', () => {
    const h = mountInside(insideState({ stageCurrent: 'impl' }), { persisted: { sel: 'uat' } });
    h.emit({ type: 'state', state: insideState({ stageCurrent: 'impl' }) } as HostMessage);
    h.emit({ type: 'state', state: insideState({ stageCurrent: 'impl' }), live: true } as HostMessage);
    h.emit({ type: 'clocks', clocks: {} } as HostMessage);
    expect(text(must('#inside-title'))).toBe('Inside uat');
  });

  it('a rail pick re-points the block in the same turn and asks the page to persist it', () => {
    const state = insideState({ stageCurrent: 'impl', rail: { main: [{ cell: { stageKey: 'impl', status: 'running' }, status: 'running', current: true, needsUser: false, needs: null, retry: null }, { cell: { stageKey: 'uat', status: 'pending' }, status: 'pending', current: false, needsUser: false, needs: null, retry: null }] } });
    const h = mountInside(state, { withRail: true });
    expect(text(must('#inside-title'))).toBe('Inside impl');
    fireEvent.click(must('#rail .pick[data-stage="uat"]'));
    expect(text(must('#inside-title'))).toBe('Inside uat');
    expect(h.persisted).toEqual([{ sel: 'uat', shipWait: null }]);
  });

  it('a new ship wait selects Ship once, and the user can leave it', () => {
    const h = mountInside(insideState({ stageCurrent: 'impl' }));
    h.emit({ type: 'state', state: insideState({ stageCurrent: 'ship', ship: { kind: 'confirm' } }) } as HostMessage);
    expect(text(must('#inside-title'))).toBe('Inside ship');
    expect(h.persisted).toEqual([{ sel: 'ship', shipWait: `${942017}:confirm` }]);
  });
});

describe('Inside — the header’s live operation', () => {
  const running = (over: Record<string, unknown> = {}) => ({ status: 'run', label: 'lint (web)', detail: 'running eslint', duration: '3s', ...over });

  it('says what the stage is doing: glyph by status (word as its name), label, detail, duration', () => {
    mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { live: running() }) } }));
    const live = must('.inside-live');
    expect(live.classList.contains('run')).toBe(true);
    expect(live.querySelector('.glyph.run')!.getAttribute('aria-label')).toBe('running');
    expect(text(live.querySelector('strong'))).toBe('lint (web)');
    expect(text(live.querySelector('.live-copy'))).toBe('running eslint');
    expect(text(live.querySelector('.duration'))).toBe('3s');
    expect(all('.inside-live .sep')).toHaveLength(2);
  });

  it('draws nothing for a settled stage and omits the parts the operation does not state', () => {
    mountInside(insideState({ stageCurrent: 'uat' }));
    expect(must('.inside-live').childElementCount).toBe(0);
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { live: { status: 'wait' } }) } }));
    expect(must('.inside-live').classList.contains('wait')).toBe(true);
    expect(text(must('.inside-live strong'))).toBe('');
    expect(q('.live-copy')).toBeNull();
    expect(q('.inside-live .duration')).toBeNull();
  });

  it('names the AI identity running the operation', () => {
    mountInside(
      insideState({ stageCurrent: 'uat', views: { uat: view('uat', { live: running({ execution: { provider: 'claude', providerLabel: 'Claude Code', model: 'm', modelLabel: 'Model A', agentName: 'bob' } }) }) } }),
    );
    expect(text(must('.inside-live .ai-mark'))).toBe('AI');
    expect(text(must('.inside-live .agent-name'))).toBe('bob');
    expect(text(must('.inside-live .agent-core'))).toBe('Claude Code');
    expect(text(must('.inside-live .agent-model'))).toBe('Model A');
  });

  it('shows a progress event over the snapshot line, then retires it with the snapshot that holds its process', () => {
    const h = mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { live: running({ label: 'snap' }) }) } }));
    h.emit({ type: 'inside-progress', event: { kind: 'active', ticketId: 1, stage: 'uat', processId: 'gates', live: running({ label: 'event' }) } } as HostMessage);
    expect(text(must('.inside-live strong'))).toBe('event');
    h.emit({ type: 'state', state: insideState({ stageCurrent: 'uat', views: { uat: view('uat', { live: running({ label: 'snap' }), processes: [proc('gates', { status: 'fail' })] }) } }) } as HostMessage);
    expect(text(must('.inside-live strong'))).toBe('snap');
  });

  it('a clocks repaint advances the header clock and the live duration without a new snapshot', () => {
    const h = mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { clock: '1s', live: running({ duration: '1s' }) }) } }));
    h.emit({ type: 'clocks', clocks: { uat: { clock: '9s', live: '9s', processes: {} } } } as HostMessage);
    expect(text(must('.inside-meta'))).toBe('9s');
    expect(text(must('.inside-live .duration'))).toBe('9s');
  });
});

describe('Inside — the round switcher', () => {
  const attempts = [
    { key: 'r1', label: 'R1', status: 'fail', statusLabel: 'failed', tail: 'of 3', latest: false },
    { key: 'r2', label: 'R2', status: 'pass', statusLabel: 'passed', tail: 'of 3', latest: false },
    { key: 'r3', label: 'R3', status: 'run', statusLabel: 'running', tail: 'of 3 · live', latest: true },
  ];
  const state = (over: Record<string, unknown> = {}) =>
    insideState({ stageCurrent: 'review', views: { review: view('review', { attempts, selectedAttempt: 'r2', ...over }) } });
  const tabs = () => all<HTMLButtonElement>('[role="tab"]');

  it('renders nothing for a stage that never looped', () => {
    mountInside(state({ attempts: [attempts[0]] }));
    expect(q('.attempt-tabs')).toBeNull();
    cleanupInside();
    mountInside(state({ attempts: undefined }));
    expect(q('.attempt-tabs')).toBeNull();
  });

  it('draws a tablist with the selected tab in the tab order (roving tabindex) and stage-scoped ids', () => {
    mountInside(state());
    expect(must('.attempt-tabs').getAttribute('role')).toBe('tablist');
    expect(must('.attempt-tabs').getAttribute('aria-label')).toBe('Rounds');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs().map((t) => t.id)).toEqual(['attempt-tab-review-0', 'attempt-tab-review-1', 'attempt-tab-review-2']);
    expect(text(tabs()[0]!.querySelector('.attempt-tab-label'))).toBe('R1');
    expect(tabs()[0]!.querySelector('.attempt-tab-status')).toBeNull();
    expect(tabs()[0]!.querySelector('.glyph')!.getAttribute('aria-hidden')).toBe('true');
    expect(tabs()[1]!.dataset.keys).toBe('r1,r2,r3');
    expect(tabs()[1]!.dataset.index).toBe('1');
  });

  it('labels tabs R<n>, shows the tail only on the selected tab, and keeps the status word in the accessible name', () => {
    mountInside(state());
    expect(tabs().map((t) => text(t))).toEqual(['R1', 'R2of 3', 'R3']);
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['R1, failed', 'R2 of 3, passed', 'R3, running']);
    expect(text(must('.attempt-tabs-label'))).toBe('Rounds');
    expect(all('.attempt-conn').length).toBe(2);
    expect(must('.attempt-conn').getAttribute('aria-hidden')).toBe('true');
  });

  it('a click posts the selection and waits for the host’s snapshot to move aria-selected', () => {
    const h = mountInside(state());
    fireEvent.click(tabs()[0]!);
    expect(h.send.selectGateAttempt.mock.calls).toEqual([['review', 'r1']]);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('false');
    h.emit({ type: 'state', state: state({ selectedAttempt: 'r1' }) } as HostMessage);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('Left and Right move the selection and the focus to the neighbour, and stop at either end', () => {
    const h = mountInside(state());
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' });
    expect(h.send.selectGateAttempt.mock.calls).toEqual([['review', 'r3']]);
    expect(document.activeElement).toBe(tabs()[2]);
    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' });
    expect(h.send.selectGateAttempt).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowLeft' });
    expect(h.send.selectGateAttempt.mock.calls.at(-1)).toEqual(['review', 'r1']);
    expect(document.activeElement).toBe(tabs()[0]);
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' });
    expect(h.send.selectGateAttempt).toHaveBeenCalledTimes(2);
  });

  it('shows the host’s note above the ledger verbatim', () => {
    mountInside(state({ attemptNote: 'opened by UAT test failure · 48s' }));
    expect(text(must('.attempt-note'))).toBe('opened by UAT test failure · 48s');
    expect(all('.attempt-note').length).toBe(1);
  });

  it('keeps the ledger at one sibling slot after the head whatever the round row and caption render', () => {
    mountInside(state({ attemptNote: 'opened by UAT test failure · 48s' }));
    const slot = must('.attempt-slot');
    expect(slot.querySelector('.attempt-note')).not.toBeNull();
    expect(slot.previousElementSibling?.classList.contains('inside-head')).toBe(true);
    expect(slot.querySelectorAll('.attempt-note').length).toBe(1);
  });
});
