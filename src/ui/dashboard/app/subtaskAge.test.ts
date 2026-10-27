import { describe, expect, it } from 'vitest';
import { spanShort, subtaskAge } from './subtaskAge.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const row = (over: Record<string, unknown> = {}) => ({
  stage: 'impl',
  done: false,
  fault: null,
  stageSince: null,
  queuePos: null,
  ...over,
});

describe('spanShort', () => {
  it('reads seconds, minutes, hours, days — one unit', () => {
    expect([0, 45_000, 4 * MIN, 59 * MIN + 59_000, 3 * HOUR + 40 * MIN, 49 * HOUR].map(spanShort)).toEqual(['0s', '45s', '4m', '59m', '3h', '2d']);
  });
  it('clamps a future timestamp to zero', () => {
    expect(spanShort(-5)).toBe('0s');
  });
});

describe('subtaskAge', () => {
  it('shows the elapsed time in the current stage while running', () => {
    expect(subtaskAge(row({ stageSince: ago(4 * MIN) }), NOW)).toEqual({ text: '4m', title: 'In impl for 4m' });
  });
  it('counts from the block start when a fault is set', () => {
    const age = subtaskAge(row({ stageSince: ago(HOUR), fault: { since: ago(12 * MIN) } }), NOW);
    expect(age).toEqual({ text: '12m', title: 'Blocked for 12m' });
  });
  it('reads Xh ago on a done row', () => {
    expect(subtaskAge(row({ stage: 'done', done: true, stageSince: ago(2 * HOUR) }), NOW)).toEqual({ text: '2h ago', title: 'Done 2h ago' });
  });
  it('shows the queue position of an autostart-queued row', () => {
    expect(subtaskAge(row({ stage: 'scope', queuePos: 2 }), NOW)).toEqual({ text: '#2', title: '#2 in the autostart queue' });
  });
  it('is null with nothing to say, or an unparseable stamp', () => {
    expect(subtaskAge(row(), NOW)).toBeNull();
    expect(subtaskAge(row({ stageSince: 'garbage' }), NOW)).toBeNull();
    expect(subtaskAge(row({ stage: null, stageSince: ago(MIN) }), NOW)).toEqual({ text: '1m', title: 'In stage for 1m' });
  });
});
