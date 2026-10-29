import { describe, it, expect } from 'vitest';
import { quotaLaunchWarning, formatDuration, formatResetDate } from './warn.js';
import type { QuotaSnapshot } from './types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const ok = (used: number[]): QuotaSnapshot => ({
  core: 'codex',
  state: 'ok',
  windows: used.map((u, i) => ({ label: `w${i}`, usedPct: u, resetsAt: null })),
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

const unknown: QuotaSnapshot = { core: 'codex', state: 'unknown', reason: 'nope' };

describe('formatDuration', () => {
  it('formats < 1m for sub-minute or non-positive durations', () => {
    expect(formatDuration(0)).toBe('< 1m');
    expect(formatDuration(30_000)).toBe('< 1m');
    expect(formatDuration(59_999)).toBe('< 1m');
    expect(formatDuration(-10_000)).toBe('< 1m');
  });

  it('formats sub-hour durations in minutes', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('formats sub-day durations in hours and minutes', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h 0m');
    expect(formatDuration((5 * 60 + 30) * 60_000)).toBe('5h 30m');
    expect(formatDuration((23 * 60 + 59) * 60_000)).toBe('23h 59m');
  });

  it('formats multi-day durations in days and hours', () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe('1d 0h');
    expect(formatDuration((24 + 6) * 60 * 60_000)).toBe('1d 6h');
    expect(formatDuration((3 * 24 + 14) * 60 * 60_000)).toBe('3d 14h');
  });
});

describe('formatResetDate', () => {
  it('formats local reset date with short month, day, 2-digit hour and minute', () => {
    const oct30 = new Date(2026, 9, 30, 19, 0);
    expect(formatResetDate(oct30)).toBe('Oct 30, 19:00');

    const jan5 = new Date(2026, 0, 5, 8, 5);
    expect(formatResetDate(jan5)).toBe('Jan 5, 08:05');

    const midnight = new Date(2026, 11, 31, 0, 0);
    expect(formatResetDate(midnight)).toBe('Dec 31, 00:00');
  });
});

describe('quotaLaunchWarning', () => {
  it('returns null for an absent or unknown snapshot', () => {
    expect(quotaLaunchWarning(undefined, 80, 'Codex', NOW)).toBeNull();
    expect(quotaLaunchWarning(unknown, 80, 'Codex', NOW)).toBeNull();
  });

  it('returns null below the threshold', () => {
    expect(quotaLaunchWarning(ok([79]), 80, 'Codex', NOW)).toBeNull();
  });

  it('warns at exactly the threshold', () => {
    const message = quotaLaunchWarning(ok([80]), 80, 'Codex', NOW);
    expect(message).toBe(
      'Codex is at 80% of w0 quota (threshold 80%).\n' +
      'Karst will not block.',
    );
  });

  it('warns at the threshold and above, naming the tightest window and rounding usedPct', () => {
    const message = quotaLaunchWarning(ok([50, 82.4]), 80, 'Codex', NOW);
    expect(message).toBe(
      'Codex is at 82% of w1 quota (threshold 80%).\n' +
      'Karst will not block.',
    );

    const messageRoundUp = quotaLaunchWarning(ok([50, 82.6]), 80, 'Codex', NOW);
    expect(messageRoundUp).toContain('Codex is at 83% of w1 quota');
  });

  it('formats line 2 with countdown duration and local reset date when resetsAt is given', () => {
    // 1 day 6 hours after NOW
    const resetDate = new Date(NOW.getTime() + (30 * 60) * 60_000);
    const expectedLocalDate = formatResetDate(resetDate);
    const snapshot: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [{ label: '7-day', usedPct: 90, resetsAt: resetDate.toISOString() }],
      source: 'test',
      readAt: NOW.toISOString(),
    };
    const message = quotaLaunchWarning(snapshot, 80, 'Codex', NOW);
    expect(message).toBe(
      `Codex is at 90% of 7-day quota (threshold 80%).\n` +
      `Resets in 1d 6h (${expectedLocalDate}) · Karst will not block.`,
    );
  });

  it('falls back to reassurance line when resetsAt is invalid', () => {
    const snapshot: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [{ label: '7-day', usedPct: 90, resetsAt: 'invalid-date' }],
      source: 'test',
      readAt: NOW.toISOString(),
    };
    const message = quotaLaunchWarning(snapshot, 80, 'Codex', NOW);
    expect(message).toBe(
      'Codex is at 90% of 7-day quota (threshold 80%).\n' +
      'Karst will not block.',
    );
  });

  it('keeps all line lengths under 65 chars to avoid IDE notification clipping', () => {
    const resetDate = new Date(NOW.getTime() + (30 * 60) * 60_000);
    const snapshot: QuotaSnapshot = {
      core: 'antigravity',
      state: 'ok',
      windows: [{ label: 'gemini-weekly', usedPct: 99.5, resetsAt: resetDate.toISOString() }],
      source: 'test',
      readAt: NOW.toISOString(),
    };
    const message = quotaLaunchWarning(snapshot, 80, 'Antigravity', NOW)!;
    expect(message).not.toBeNull();
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThan(65);
    }
  });

  it('does not warn on a window whose reset instant has already passed', () => {
    const expired: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [{ label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }],
      source: 'test',
      readAt: '2025-12-25T00:00:00.000Z',
    };
    expect(quotaLaunchWarning(expired, 80, 'Codex', NOW)).toBeNull();
  });

  it('warns on the still-open window when a tighter one has expired', () => {
    const mixed: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [
        { label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' },
        { label: '7-day', usedPct: 82, resetsAt: '2026-01-03T00:00:00.000Z' },
      ],
      source: 'test',
      readAt: '2025-12-25T00:00:00.000Z',
    };
    const message = quotaLaunchWarning(mixed, 80, 'Codex', NOW);
    expect(message).toContain('Codex is at 82% of 7-day quota (threshold 80%).');
    expect(message).toContain('Karst will not block.');
  });
});

