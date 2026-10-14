import { describe, it, expect } from 'vitest';
import { quotaLaunchWarning } from './warn.js';
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

describe('quotaLaunchWarning', () => {
  it('returns null for an absent or unknown snapshot', () => {
    expect(quotaLaunchWarning(undefined, 80, 'Codex', NOW)).toBeNull();
    expect(quotaLaunchWarning(unknown, 80, 'Codex', NOW)).toBeNull();
  });

  it('returns null below the threshold', () => {
    expect(quotaLaunchWarning(ok([79]), 80, 'Codex', NOW)).toBeNull();
  });

  it('warns at the threshold and above, naming the tightest window', () => {
    const message = quotaLaunchWarning(ok([50, 82]), 80, 'Codex', NOW);
    expect(message).toContain('Codex is at 82%');
    expect(message).toContain('w1');
    expect(message).toContain('warn threshold 80%');
    expect(message).toContain('will not block or switch cores');
  });

  it('names the reset instant when the provider gave one', () => {
    const snapshot: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [{ label: 'w', usedPct: 90, resetsAt: '2026-01-02T00:00:00.000Z' }],
      source: 'test',
      readAt: '2026-01-01T00:00:00.000Z',
    };
    expect(quotaLaunchWarning(snapshot, 80, 'Codex', NOW)).toContain(
      'Resets at 2026-01-02T00:00:00.000Z',
    );
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
    expect(message).toContain('Codex is at 82%');
    expect(message).toContain('7-day');
  });
});
