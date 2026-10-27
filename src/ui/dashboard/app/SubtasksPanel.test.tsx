// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Profiler } from 'react';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import type { DashboardHostBridge, DashboardSender } from './hostBridge.js';
import { DashboardAppProvider } from './DashboardAppContext.js';
import { SubtasksPanel } from './SubtasksPanel.js';

const sub = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  idLabel: `T${id}`,
  key: `FEAT-1-s${id}`,
  title: `Sub ${id}`,
  stage: 'impl',
  glyph: 'blue',
  stageClass: 'stg-impl',
  blocking: false,
  done: false,
  autostart: null,
  fault: null,
  pr: null,
  agent: null,
  stageSince: null,
  queuePos: null,
  ...over,
});
const stateWith = (over: Record<string, unknown>): DashboardState =>
  ({ ticketId: 1, key: 'FEAT-1', subtasks: [], subtaskProgress: { done: 0, total: 0 }, canAddSubtask: false, ...over }) as unknown as DashboardState;

const PANEL =
  '<div class="panel span hidden" id="subtaskPanel"><div class="phead">Sub-tasks<span class="count" id="subtaskCount"></span></div><div class="pbody" id="subtasks"></div></div>';

interface Harness {
  readonly send: { createSubtask: ReturnType<typeof vi.fn> };
  readonly emit: (message: HostMessage) => void;
}

function mount(initial: DashboardState | null, onRender?: () => void): Harness {
  document.body.innerHTML = PANEL;
  let listener: ((message: HostMessage) => void) | null = null;
  const send = { createSubtask: vi.fn() };
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial } : null),
    setState: vi.fn(),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const panel = <SubtasksPanel />;
  render(
    <DashboardAppProvider bridge={bridge}>
      {onRender ? (
        <Profiler id="st" onRender={onRender}>
          {panel}
        </Profiler>
      ) : (
        panel
      )}
    </DashboardAppProvider>,
  );
  return { send, emit: (message) => act(() => listener?.(message)) };
}

const pending = new Set<Element>();
beforeEach(() => {
  pending.clear();
  let n = 0;
  Object.assign(globalThis, {
    karstRequestId: () => `req-${++n}`,
    karstIsPending: (el: Element) => pending.has(el),
    karstBeginPending: (el: Element) => {
      pending.add(el);
      el.setAttribute('aria-busy', 'true');
    },
  });
});
afterEach(cleanup);

const root = () => document.querySelector('#subtaskPanel')!;
const add = () => document.querySelector<HTMLButtonElement>('#addSubtask')!;
const rows = () => [...document.querySelectorAll('.subtask')];

describe('SubtasksPanel — visibility', () => {
  it('stays hidden before the first snapshot', () => {
    mount(null);
    expect(root().classList.contains('hidden')).toBe(true);
    expect(add().classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#subtasks')!.childElementCount).toBe(0);
  });

  it('is hidden with no sub-tasks and no way to add one', () => {
    mount(stateWith({}));
    expect(root().classList.contains('hidden')).toBe(true);
    expect(add().classList.contains('hidden')).toBe(true);
  });

  it('shows the empty message when one can be added', () => {
    mount(stateWith({ canAddSubtask: true }));
    expect(root().classList.contains('hidden')).toBe(false);
    expect(add().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.subtask-empty')!.textContent).toBe('No sub-tasks yet. Add one to split off unfinished work.');
  });

  it('is shown for existing sub-tasks even when none can be added, without the button', () => {
    mount(stateWith({ subtasks: [sub(1)], subtaskProgress: { done: 0, total: 1 } }));
    expect(root().classList.contains('hidden')).toBe(false);
    expect(add().classList.contains('hidden')).toBe(true);
    expect(document.querySelector('.subtask-empty')).toBeNull();
  });

  it('follows later pushes', () => {
    const h = mount(stateWith({}));
    h.emit({ type: 'state', state: stateWith({ canAddSubtask: true }) });
    expect(root().classList.contains('hidden')).toBe(false);
    h.emit({ type: 'state', state: stateWith({}) });
    expect(root().classList.contains('hidden')).toBe(true);
  });
});

describe('SubtasksPanel — count and rows', () => {
  it('renders the host progress verbatim and nothing for a zero total', () => {
    mount(stateWith({ subtasks: [sub(1)], subtaskProgress: { done: 1, total: 3 } }));
    expect(document.querySelector('#subtaskCount')!.textContent).toBe('1/3 done');
    cleanup();
    mount(stateWith({ canAddSubtask: true }));
    expect(document.querySelector('#subtaskCount')!.textContent).toBe('');
  });

  it('paints one row per sub-task with id, key and title', () => {
    mount(stateWith({ subtasks: [sub(7), sub(8, { title: null })] }));
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.getAttribute('data-id')).toBe('7');
    expect(rows()[0]!.querySelector('.k-id')!.textContent).toBe('T7');
    expect(rows()[0]!.querySelector('.subtask-key')!.textContent).toBe('FEAT-1-s7');
    expect(rows()[0]!.querySelector('.subtask-title')!.textContent).toBe('Sub 7');
    expect(rows()[1]!.querySelector('.subtask-title')!.textContent).toBe('(untitled)');
  });

  it('maps the glyph to the dot class, and gray to the plain dot', () => {
    mount(
      stateWith({
        subtasks: [sub(1, { glyph: 'blue' }), sub(2, { glyph: 'amber' }), sub(3, { glyph: 'green' }), sub(4, { glyph: 'red' }), sub(5, { glyph: 'gray' })],
      }),
    );
    const dots = rows().map((r) => r.querySelector('.k-dot')!);
    expect(dots.map((d) => d.className)).toEqual([
      'k-dot k-dot--running',
      'k-dot k-dot--attention',
      'k-dot k-dot--passed',
      'k-dot k-dot--failed',
      'k-dot',
    ]);
    expect(dots[0]!.getAttribute('role')).toBe('img');
  });

  it('labels the dot with done, else the stage, else none', () => {
    mount(stateWith({ subtasks: [sub(1, { done: true, stage: 'done', stageClass: 'stg-done' }), sub(2), sub(3, { stage: null })] }));
    const labels = rows().map((r) => r.querySelector('.k-dot')!.getAttribute('aria-label'));
    expect(labels).toEqual(['done', 'impl', 'none']);
    const pills = rows().map((r) => r.querySelector('.stage')!);
    expect(pills.map((p) => p.textContent)).toEqual(['done', 'impl', 'none']);
    expect(pills[1]!.className).toBe('stage stg-impl');
    expect(pills[1]!.getAttribute('title')).toBe('impl');
  });

  it('reads Queued or Starting while the autostart sweep holds the sub-task', () => {
    mount(stateWith({ subtasks: [sub(1, { autostart: 'queued', stage: 'scope' }), sub(2, { autostart: 'starting', stage: 'scope' })] }));
    expect(rows().map((r) => r.querySelector('.stage')!.textContent)).toEqual(['Queued', 'Starting']);
    expect(rows().map((r) => r.querySelector('.k-dot')!.getAttribute('aria-label'))).toEqual(['Queued', 'Starting']);
  });

});

const FAULT = { kind: 'usage-limit', title: 'Provider out of quota', reason: 'anthropic: monthly quota exceeded', since: new Date(Date.now() - 12 * 60_000).toISOString() };

describe('SubtasksPanel — evolved row', () => {
  it('lays the cells out in the brief order', () => {
    mount(
      stateWith({
        subtasks: [
          sub(1, {
            blocking: true,
            pr: { number: 422, state: 'open', more: 0 },
            agent: { core: 'claude', coreLabel: 'Claude', model: 'm', modelShort: 'Sonnet 5.5' },
            stageSince: new Date(Date.now() - 4 * 60_000).toISOString(),
          }),
        ],
      }),
    );
    const cls = [...rows()[0]!.children].map((c) => c.className.split(' ').find((k) => /^(k-dot|k-id|subtask-|stage)/.test(k)));
    expect(cls).toEqual(['k-dot', 'k-id', 'subtask-key', 'subtask-title', 'subtask-pr', 'subtask-lock', 'subtask-agent', 'subtask-age', 'stage']);
  });

  it('puts the T-id · key — title tooltip on the title cell and none on the row', () => {
    mount(stateWith({ subtasks: [sub(7)] }));
    expect(rows()[0]!.hasAttribute('title')).toBe(false);
    expect(rows()[0]!.querySelector('.subtask-title')!.getAttribute('title')).toBe('T7 · FEAT-1-s7 — Sub 7');
  });

  it('dims done rows and omits their agent', () => {
    const agent = { core: 'claude', coreLabel: 'Claude', model: 'm', modelShort: 'S' };
    mount(stateWith({ subtasks: [sub(1, { done: true, stage: 'done', stageClass: 'stg-done', agent })] }));
    expect(rows()[0]!.classList.contains('subtask--done')).toBe(true);
    expect(rows()[0]!.querySelector('.subtask-agent')).toBeNull();
  });

  it('renders the agent as core · model with the full text in the tooltip', () => {
    mount(stateWith({ subtasks: [sub(1, { agent: { core: 'claude', coreLabel: 'Claude', model: 'claude-x', modelShort: 'Sonnet 5.5' } })] }));
    const agent = rows()[0]!.querySelector('.subtask-agent')!;
    expect(agent.textContent).toBe('Claude · Sonnet 5.5');
    expect(agent.getAttribute('title')).toBe('Claude · claude-x');
    expect(agent.querySelector('.subtask-agent-model')!.textContent).toBe(' · Sonnet 5.5');
  });

  it('names the core alone when no model resolves', () => {
    mount(stateWith({ subtasks: [sub(1, { agent: { core: 'codex', coreLabel: 'Codex', model: null, modelShort: null } })] }));
    expect(rows()[0]!.querySelector('.subtask-agent')!.textContent).toBe('Codex');
  });

  it('chips the first PR with its state, +N for more', () => {
    mount(
      stateWith({
        subtasks: [sub(1, { pr: { number: 418, state: 'merged', more: 0 } }), sub(2, { pr: { number: 422, state: 'open', more: 1 } }), sub(3)],
      }),
    );
    const chips = rows().map((r) => r.querySelector('.subtask-pr'));
    expect(chips[0]!.textContent).toBe('#418 merged');
    expect(chips[1]!.textContent).toBe('#422 open +1');
    expect(chips[0]!.querySelector('.subtask-pr-state')!.textContent).toBe(' merged');
    expect(chips[2]).toBeNull();
  });

  it('keeps the normal pill and shows a time cell with its tooltip', () => {
    mount(stateWith({ subtasks: [sub(1, { stageSince: new Date(Date.now() - 4 * 60_000).toISOString() })] }));
    const age = rows()[0]!.querySelector('.subtask-age')!;
    expect(age.textContent).toBe('4m');
    expect(age.getAttribute('title')).toBe('In impl for 4m');
    expect(rows()[0]!.querySelector('.stage')!.className).toBe('stage stg-impl');
  });

  it('shows the queue position of a queued row', () => {
    mount(stateWith({ subtasks: [sub(1, { autostart: 'queued', stage: 'scope', glyph: 'gray', queuePos: 2 })] }));
    const age = rows()[0]!.querySelector('.subtask-age')!;
    expect([age.textContent, age.getAttribute('title')]).toEqual(['#2', '#2 in the autostart queue']);
  });

  it('marks the lock only on a blocker: neutral, labelled, naming the parent', () => {
    mount(stateWith({ subtasks: [sub(1, { blocking: true }), sub(2)] }));
    const lock = rows()[0]!.querySelector('.subtask-lock')!;
    expect(lock.getAttribute('role')).toBe('img');
    expect(lock.getAttribute('aria-label')).toBe('blocker');
    expect(lock.getAttribute('title')).toBe('Blocker: FEAT-1 can’t leave impl until this sub-task is done');
    expect(lock.className).toBe('subtask-lock');
    expect(rows()[0]!.querySelector('.subtaskBlock')).toBeNull();
    expect(rows()[1]!.querySelector('.subtask-lock')).toBeNull();
  });

  it('draws a blocked row as a wrapped row with the fault on line 2 and no BLOCKED text', () => {
    mount(stateWith({ subtasks: [sub(1, { glyph: 'red', fault: FAULT })] }));
    const row = rows()[0]!;
    expect(row.classList.contains('subtask--blocked')).toBe(true);
    const line = row.querySelector('.subtask-fault')!;
    expect(line.querySelector('b.ftitle')!.textContent).toBe('Provider out of quota');
    expect(line.querySelector('.freason')!.textContent).toBe('anthropic: monthly quota exceeded');
    expect(line.textContent).toBe('Provider out of quota · anthropic: monthly quota exceeded');
    expect(line.getAttribute('title')).toBe('Provider out of quota · anthropic: monthly quota exceeded');
    expect(row.querySelector('.stage')!.textContent).toBe('impl');
    expect(row.textContent).not.toMatch(/BLOCKED/);
    expect(row.querySelector('.k-dot')!.getAttribute('aria-label')).toBe('blocked');
    expect(row.querySelector('.subtask-age')!.getAttribute('title')).toBe('Blocked for 12m');
    expect(row.classList.contains('attention')).toBe(false);
  });
});

describe('SubtasksPanel — header', () => {
  it('draws a segmented progress bar from the row states', () => {
    mount(
      stateWith({
        subtasks: [sub(1, { done: true, stage: 'done', glyph: 'green' }), sub(2), sub(3, { glyph: 'red', fault: FAULT }), sub(4, { glyph: 'gray' })],
        subtaskProgress: { done: 1, total: 4 },
      }),
    );
    const bar = document.querySelector('.subtask-progress')!;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    const segs = [...bar.children].map((c) => c.className);
    expect(segs).toEqual([
      'seg seg--passed',
      'seg seg--running',
      'seg seg--failed',
      'seg seg--rest',
    ]);
  });

  it('draws no bar without sub-tasks', () => {
    mount(stateWith({ canAddSubtask: true }));
    expect(document.querySelector('.subtask-progress')).toBeNull();
  });

  it('keeps the Add label as a span CSS can hide', () => {
    mount(stateWith({ canAddSubtask: true }));
    expect(add().querySelector('.k-btn-label')!.textContent).toBe('Add sub-task');
  });
});

describe('SubtasksPanel — Add sub-task', () => {
  it('keeps the vanilla markup contract', () => {
    mount(stateWith({ canAddSubtask: true }));
    expect(add().textContent).toBe('Add sub-task');
    expect(add().getAttribute('aria-label')).toBe('Add sub-task');
    expect(add().getAttribute('data-act')).toBe('create-subtask');
    expect(add().getAttribute('title')).toBe('Create a sub-task under this ticket');
    expect(add().getAttribute('type')).toBe('button');
    expect(add().className).toBe('k-btn k-btn--ghost k-btn--sm');
    expect(add().parentElement!.classList.contains('phead')).toBe(true);
    expect(add().previousElementSibling!.id).toBe('subtaskCount');
  });

  it('posts once with the request id and stays pending until settled', () => {
    const h = mount(stateWith({ canAddSubtask: true }));
    fireEvent.click(add());
    expect(h.send.createSubtask).toHaveBeenCalledTimes(1);
    expect(h.send.createSubtask).toHaveBeenCalledWith('req-1');
    expect(add().getAttribute('aria-busy')).toBe('true');
    fireEvent.click(add());
    expect(h.send.createSubtask).toHaveBeenCalledTimes(1);
  });

  it('keeps the runtime pending class across pushes (class never rewritten)', () => {
    const h = mount(stateWith({ canAddSubtask: true }));
    add().classList.add('is-pending');
    h.emit({ type: 'state', state: stateWith({ canAddSubtask: true, subtasks: [sub(1)] }) });
    expect(add().classList.contains('is-pending')).toBe(true);
  });
});

describe('SubtasksPanel — slice selection (migration plan A4)', () => {
  it('does not re-render on a live push whose sub-task slice is structurally unchanged', () => {
    const onRender = vi.fn();
    const h = mount(stateWith({ subtasks: [sub(1)], subtaskProgress: { done: 0, total: 1 } }), onRender);
    const before = onRender.mock.calls.length;
    h.emit({ type: 'state', state: { ...stateWith({ subtasks: [sub(1)], subtaskProgress: { done: 0, total: 1 } }), clock: 't1' } as unknown as DashboardState, live: true });
    h.emit({ type: 'state', state: { ...stateWith({ subtasks: [sub(1)], subtaskProgress: { done: 0, total: 1 } }), clock: 't2' } as unknown as DashboardState, live: true });
    expect(onRender.mock.calls.length).toBe(before);
    h.emit({ type: 'state', state: stateWith({ subtasks: [sub(1), sub(2)], subtaskProgress: { done: 0, total: 2 } }), live: true });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(rows()).toHaveLength(2);
  });
});
