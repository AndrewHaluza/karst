import { describe, it, expect } from 'vitest';
import { isWindowExpired, tightestUsedPct, tightestWindow, type QuotaSnapshot, type QuotaWindow } from './types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const known = (windows: QuotaWindow[]): QuotaSnapshot => ({
  core: 'codex',
  state: 'ok',
  windows,
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

describe('isWindowExpired', () => {
  it('is false for a window with no reset stamp', () => {
    expect(isWindowExpired({ label: 'w', usedPct: 90, resetsAt: null }, NOW)).toBe(false);
  });

  it('is false for an unparseable reset stamp', () => {
    expect(isWindowExpired({ label: 'w', usedPct: 90, resetsAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('is false for a reset instant still in the future', () => {
    expect(isWindowExpired({ label: 'w', usedPct: 90, resetsAt: '2026-01-01T00:00:01.000Z' }, NOW)).toBe(false);
  });

  it('is true at and after the reset instant', () => {
    expect(isWindowExpired({ label: 'w', usedPct: 90, resetsAt: '2026-01-01T00:00:00.000Z' }, NOW)).toBe(true);
    expect(isWindowExpired({ label: 'w', usedPct: 90, resetsAt: '2025-12-25T00:00:00.000Z' }, NOW)).toBe(true);
  });
});

describe('isWindowExpired max-age guard', () => {
  const H = 3_600_000;
  const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const w5 = { label: '5-hour', usedPct: 100, resetsAt: null };

  it('expires a null-reset 5-hour window read more than 5h ago', () => {
    expect(isWindowExpired(w5, NOW, at(6 * H))).toBe(true);
  });

  it('keeps a null-reset 5-hour window read 1h ago open', () => {
    expect(isWindowExpired(w5, NOW, at(1 * H))).toBe(false);
  });

  it('expires a null-reset 7-day window only after 7 days', () => {
    const w7 = { label: '7-day', usedPct: 50, resetsAt: null };
    expect(isWindowExpired(w7, NOW, at(6 * 24 * H))).toBe(false);
    expect(isWindowExpired(w7, NOW, at(8 * 24 * H))).toBe(true);
  });

  it('keeps a future reset stamp open whatever the readAt', () => {
    const w = { label: '5-hour', usedPct: 90, resetsAt: '2026-01-01T01:00:00.000Z' };
    expect(isWindowExpired(w, NOW, at(10 * H))).toBe(false);
  });

  it('keeps an unknown label, an unparseable readAt or a missing readAt open', () => {
    expect(isWindowExpired({ label: 'Weekly', usedPct: 9, resetsAt: null }, NOW, at(99 * H))).toBe(false);
    expect(isWindowExpired(w5, NOW, 'bad')).toBe(false);
    expect(isWindowExpired(w5, NOW)).toBe(false);
  });

  it('tightestWindow skips an aged null-reset window', () => {
    const snap: QuotaSnapshot = {
      core: 'claude',
      state: 'ok',
      windows: [w5],
      source: 'test',
      readAt: at(6 * H),
    };
    expect(tightestWindow(snap, NOW)).toBeNull();
  });
});

describe('tightestWindow', () => {
  it('is null for an unknown core', () => {
    expect(tightestWindow({ core: 'codex', state: 'unknown', reason: 'x' }, NOW)).toBeNull();
  });

  it('picks the highest-usage open window', () => {
    const window = tightestWindow(
      known([
        { label: 'a', usedPct: 20, resetsAt: null },
        { label: 'b', usedPct: 76, resetsAt: null },
      ]),
      NOW,
    );
    expect(window?.label).toBe('b');
  });

  it('skips an expired window even when it is the highest-usage one', () => {
    const window = tightestWindow(
      known([
        { label: 'expired', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' },
        { label: 'open', usedPct: 20, resetsAt: '2026-01-03T00:00:00.000Z' },
      ]),
      NOW,
    );
    expect(window?.label).toBe('open');
  });

  it('is null when every window has expired', () => {
    expect(
      tightestWindow(known([{ label: 'a', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }]), NOW),
    ).toBeNull();
  });
});

describe('tightestWindow — secondary windows', () => {
  const LATER = '2026-01-02T00:00:00.000Z';
  const PAST = '2025-12-25T00:00:00.000Z';

  it('prefers an open primary window over a higher-usage secondary pool', () => {
    const snapshot = known([
      { label: '5-hour', usedPct: 88, resetsAt: LATER },
      { label: 'Weekly', usedPct: 59, resetsAt: LATER },
      { label: 'Claude/GPT (Weekly)', usedPct: 100, resetsAt: LATER, secondary: true },
      { label: 'Argon (Weekly)', usedPct: 100, resetsAt: LATER, secondary: true },
    ]);
    expect(tightestWindow(snapshot, NOW)?.label).toBe('5-hour');
    expect(tightestUsedPct(snapshot, NOW)).toBe(88);
  });

  it('picks the higher primary window whichever order it appears in', () => {
    expect(
      tightestWindow(
        known([
          { label: 'low', usedPct: 10, resetsAt: null },
          { label: 'high', usedPct: 70, resetsAt: null },
          { label: 'side', usedPct: 100, resetsAt: null, secondary: true },
        ]),
        NOW,
      )?.label,
    ).toBe('high');
    expect(
      tightestWindow(
        known([
          { label: 'high', usedPct: 70, resetsAt: null },
          { label: 'low', usedPct: 10, resetsAt: null },
          { label: 'side', usedPct: 100, resetsAt: null, secondary: true },
        ]),
        NOW,
      )?.label,
    ).toBe('high');
  });

  it('keeps the first primary window when two are equally used', () => {
    expect(
      tightestWindow(
        known([
          { label: 'first', usedPct: 70, resetsAt: null },
          { label: 'second', usedPct: 70, resetsAt: null },
        ]),
        NOW,
      )?.label,
    ).toBe('first');
  });

  it('falls back to the tightest open secondary pool when no primary window is open', () => {
    const snapshot = known([
      { label: 'p1', usedPct: 95, resetsAt: PAST },
      { label: 's1', usedPct: 60, resetsAt: null, secondary: true },
      { label: 's2', usedPct: 95, resetsAt: null, secondary: true },
      { label: 's3', usedPct: 95, resetsAt: null, secondary: true },
      { label: 's4', usedPct: 70, resetsAt: null, secondary: true },
    ]);
    expect(tightestWindow(snapshot, NOW)?.label).toBe('s2');
    expect(tightestUsedPct(snapshot, NOW)).toBe(95);
  });

  it('falls back to a secondary pool when the snapshot has no primary window at all', () => {
    expect(
      tightestWindow(
        known([{ label: 'Argon (Weekly)', usedPct: 42, resetsAt: null, secondary: true }]),
        NOW,
      )?.label,
    ).toBe('Argon (Weekly)');
  });

  it('skips an expired secondary pool', () => {
    expect(
      tightestWindow(
        known([
          { label: 'p1', usedPct: 20, resetsAt: PAST },
          { label: 's1', usedPct: 99, resetsAt: PAST, secondary: true },
          { label: 's2', usedPct: 30, resetsAt: null, secondary: true },
        ]),
        NOW,
      )?.label,
    ).toBe('s2');
  });

  it('is null when every primary and secondary window has expired', () => {
    expect(
      tightestWindow(
        known([
          { label: 'p1', usedPct: 95, resetsAt: PAST },
          { label: 's1', usedPct: 100, resetsAt: PAST, secondary: true },
        ]),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('tightestUsedPct', () => {
  it('is the tightest open window’s used-%, else null', () => {
    expect(tightestUsedPct(known([{ label: 'a', usedPct: 42, resetsAt: null }]), NOW)).toBe(42);
    expect(tightestUsedPct(known([{ label: 'a', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }]), NOW)).toBeNull();
    expect(tightestUsedPct({ core: 'codex', state: 'unknown', reason: 'x' }, NOW)).toBeNull();
  });
});
