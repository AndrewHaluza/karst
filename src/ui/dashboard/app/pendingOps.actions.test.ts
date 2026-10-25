import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import { PendingOps } from './pendingOps.js';

const settle = vi.fn();
let ops: PendingOps;

beforeEach(() => {
  settle.mockReset();
  (globalThis as unknown as { karstSettle: typeof settle }).karstSettle = settle;
  ops = new PendingOps();
});
afterEach(() => ops.dispose());

const push = (state: Record<string, unknown>, extra: Record<string, unknown> = {}): void =>
  ops.receive({ type: 'state', state, ...extra } as unknown as HostMessage);
const at = (stageCurrent: string) => ({ stageCurrent, currentStage: null, prs: [] });

describe('PendingOps — the stage menu, the deliver row and the ship preview (one request in flight each)', () => {
  it('starts with nothing in flight and reports the operation once begun', () => {
    expect(ops.getSnapshot().running.size).toBe(0);
    ops.beginAction('deliver', 'r1');
    expect(ops.isRunning('deliver')).toBe(true);
    expect(ops.getSnapshot().running.has('deliver')).toBe(true);
    expect(ops.isRunning('rebase')).toBe(false);
  });

  it.each([
    ['sendBack', 'impl', true, 'Sent back to Implement.'],
    ['sendBack', 'ship', null, 'The ticket was not moved.'],
    ['prFeedback', 'fix', true, 'Addressing pull request feedback.'],
    ['prFeedback', 'ship', null, 'The ticket was not moved.'],
    ['ci', 'impl', true, 'Sent the CI failure to the agent.'],
    ['ci', 'ship', null, 'The ticket was not moved.'],
    ['rebase', 'ship', null, 'Rebase finished; see the notification for the result.'],
    ['deliver', 'ship', null, 'Deliver to PR finished; see the notification for the result.'],
    ['previewRefresh', 'ship', true, undefined],
  ] as const)('settles %s on a settling push at %s as %s', (name, stage, ok, message) => {
    ops.beginAction(name, 'r1');
    push(at(stage));
    expect(settle).toHaveBeenCalledWith('r1', ok, ...(message === undefined ? [] : [message]));
    expect(ops.isRunning(name)).toBe(false);
  });

  it('survives a passive push and settles every operation in flight on the next settling one', () => {
    ops.beginAction('ci', 'r1');
    ops.beginAction('deliver', 'r2');
    push(at('impl'), { settlesActions: false });
    expect(ops.getSnapshot().running.size).toBe(2);
    expect(settle).not.toHaveBeenCalled();
    push(at('impl'));
    expect(settle).toHaveBeenCalledTimes(2);
    expect(ops.getSnapshot().running.size).toBe(0);
  });

  it('keeps the running set identity when nothing settles', () => {
    ops.beginAction('rebase', 'r1');
    const set = ops.getSnapshot().running;
    push(at('ship'), { settlesActions: false });
    expect(ops.getSnapshot().running).toBe(set);
  });

  it('does not touch the ship or merge requests', () => {
    ops.beginShip('s1');
    ops.beginMerge('/a', 'm1');
    ops.beginAction('ci', 'c1');
    push({ stageCurrent: 'ship', currentStage: { stageKey: 'ship', status: 'running' }, prs: [] });
    expect(settle.mock.calls.map((c) => c[0])).toEqual(['m1', 'c1']);
    expect(ops.getSnapshot().shipping).toBe(true);
  });
});
