import { describe, it, expect } from 'vitest';
import type { StepperCell } from '../stepper.js';
import { formatClock, formatExactDuration, formatTime, dotFor } from './types.js';

const NOW = '2026-08-09T12:30:00.000Z';

function cell(stageKey: StepperCell['stageKey'], over: Partial<StepperCell> = {}): StepperCell {
  return { stageKey, status: 'passed', ...over };
}

describe('dotFor', () => {
  it('reads a bypassed stage as idle — it advanced without proving a gate pass', () => {
    expect(dotFor(cell('review', { status: 'bypassed' }))).toBe('idle');
    expect(dotFor(cell('uat', { status: 'bypassed' }))).not.toBe('done');
  });
});

describe('formatExactDuration', () => {
  it('returns empty for a missing start or end', () => {
    expect(formatExactDuration(null, '2026-08-09T12:00:00.000Z')).toBe('');
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', null)).toBe('');
    expect(formatExactDuration(undefined, undefined)).toBe('');
  });

  it('returns empty for an unparseable stamp', () => {
    expect(formatExactDuration('not-a-date', '2026-08-09T12:00:00.000Z')).toBe('');
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', 'also-not')).toBe('');
  });

  it('returns empty for a negative span', () => {
    expect(formatExactDuration('2026-08-09T12:01:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('');
  });

  it('states a zero-length span as a recorded instant, not an absence', () => {
    expect(formatExactDuration('2026-08-09T12:00:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('0.000s');
  });

  it('states the span exactly, to the millisecond', () => {
    expect(
      formatExactDuration('2026-08-09T12:00:00.000Z', '2026-08-09T12:04:34.281Z'),
    ).toBe('274.281s');
  });
});

describe('formatClock', () => {
  it('shows the done stage as its completion time only — the header names the stamp, never a 0.0s span', () => {
    // The done stage is stamped at arrival, so its span is the same instant;
    // the durations live in the receipt's Timing strip, not the header.
    const stamp = '2026-08-09T12:00:00.000Z';
    expect(formatClock(cell('done', { startedAt: stamp, endedAt: stamp }), stamp)).toBe(formatTime(stamp));
    expect(formatClock(cell('done', { startedAt: stamp, endedAt: stamp }), stamp)).not.toContain('·');
  });

  it('keeps the duration on every other completed stage', () => {
    expect(
      formatClock(cell('uat', { startedAt: '2026-08-09T12:00:00.000Z', endedAt: '2026-08-09T12:03:02.000Z' }), NOW),
    ).toBe(`${formatTime('2026-08-09T12:00:00.000Z')} · 3m 2s`);
  });

  it('keeps the elapsed span on a running stage', () => {
    expect(
      formatClock(cell('impl', { status: 'running', startedAt: '2026-08-09T12:00:00.000Z' }), '2026-08-09T12:04:12.000Z'),
    ).toBe(`started ${formatTime('2026-08-09T12:00:00.000Z')} · 4m 12s elapsed`);
  });
});
