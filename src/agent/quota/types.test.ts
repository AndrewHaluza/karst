import { describe, it, expect } from 'vitest';
import { isWindowExpired, tightestUsedPct, tightestWindow, type QuotaSnapshot } from './types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const known = (windows: Array<{ label: string; usedPct: number; resetsAt: string | null }>): QuotaSnapshot => ({
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

describe('tightestUsedPct', () => {
  it('is the tightest open window’s used-%, else null', () => {
    expect(tightestUsedPct(known([{ label: 'a', usedPct: 42, resetsAt: null }]), NOW)).toBe(42);
    expect(tightestUsedPct(known([{ label: 'a', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }]), NOW)).toBeNull();
    expect(tightestUsedPct({ core: 'codex', state: 'unknown', reason: 'x' }, NOW)).toBeNull();
  });
});
