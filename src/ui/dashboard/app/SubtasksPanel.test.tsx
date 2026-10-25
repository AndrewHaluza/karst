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
  ...over,
});
const stateWith = (over: Record<string, unknown>): DashboardState =>
  ({ ticketId: 1, subtasks: [], subtaskProgress: { done: 0, total: 0 }, canAddSubtask: false, ...over }) as unknown as DashboardState;

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

  it('marks a blocking sub-task with a text chip, others without', () => {
    mount(stateWith({ subtasks: [sub(1, { blocking: true }), sub(2)] }));
    const chip = rows()[0]!.querySelector('.subtaskBlock')!;
    expect(chip.textContent).toBe('Blocking');
    expect(chip.getAttribute('title')).toBe('Holds the parent before it leaves implement');
    expect(rows()[1]!.querySelector('.subtaskBlock')).toBeNull();
  });
});

describe('SubtasksPanel — Add sub-task', () => {
  it('keeps the vanilla markup contract', () => {
    mount(stateWith({ canAddSubtask: true }));
    expect(add().textContent).toBe('Add sub-task…');
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
