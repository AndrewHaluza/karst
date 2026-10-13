import { describe, it, expect } from 'vitest';
import { buildQuotaView, formatAge, formatCountdown } from './quotaState.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const ok = (overrides: Partial<Extract<QuotaSnapshot, { state: 'ok' }>> = {}): QuotaSnapshot => ({
  core: 'codex',
  state: 'ok',
  windows: [
    { label: '7-day', usedPct: 76, resetsAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString() },
  ],
  source: 'Codex session rate limits',
  readAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
  ...overrides,
});

describe('formatAge', () => {
  it('renders just-now, minutes, hours and days', () => {
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(3 * 60_000)).toBe('3m ago');
    expect(formatAge(2 * 3_600_000)).toBe('2h ago');
    expect(formatAge(4 * 24 * 3_600_000)).toBe('4d ago');
  });
  it('never renders a negative age', () => {
    expect(formatAge(-5_000)).toBe('just now');
  });
});

describe('formatCountdown', () => {
  it('renders seconds, minutes, hours and days', () => {
    expect(formatCountdown(30_000)).toBe('30s');
    expect(formatCountdown(13 * 60_000)).toBe('13m');
    expect(formatCountdown(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m');
    expect(formatCountdown(2 * 24 * 3_600_000 + 3 * 3_600_000)).toBe('2d 3h');
  });
  it('says resetting now once the instant has passed', () => {
    expect(formatCountdown(0)).toBe('resetting now');
    expect(formatCountdown(-1000)).toBe('resetting now');
  });
});

describe('buildQuotaView', () => {
  it('builds a row per snapshot with host-formatted windows', () => {
    const view = buildQuotaView([ok()], 80, NOW);
    expect(view.thresholdPct).toBe(80);
    expect(view.anyNear).toBe(false);
    const row = view.rows[0]!;
    expect(row).toMatchObject({ core: 'codex', label: 'Codex', state: 'ok', readAgo: '3m ago' });
    expect(row.windows[0]).toMatchObject({ label: '7-day', usedPct: 76, level: 'ok', width: '76', resetsIn: '2h 0m' });
  });

  it('bands a window near the threshold and exhausted at 100', () => {
    const view = buildQuotaView(
      [ok({ windows: [
        { label: 'a', usedPct: 80, resetsAt: null },
        { label: 'b', usedPct: 100, resetsAt: null },
      ] })],
      80,
      NOW,
    );
    expect(view.rows[0]!.windows.map((w) => w.level)).toEqual(['near', 'exhausted']);
    expect(view.anyNear).toBe(true);
  });

  it('does not flag anyNear when the tightest window has already expired', () => {
    const view = buildQuotaView(
      [ok({ windows: [{ label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }] })],
      80,
      NOW,
    );
    expect(view.anyNear).toBe(false);
  });

  it('renders an unknown core with its reason and no windows', () => {
    const view = buildQuotaView([{ core: 'opencode', state: 'unknown', reason: 'no source' }], 80, NOW);
    expect(view.rows[0]).toMatchObject({
      core: 'opencode',
      label: 'OpenCode',
      state: 'unknown',
      windows: [],
      reason: 'no source',
      readAgo: null,
    });
    expect(view.anyNear).toBe(false);
  });

  it('rounds and clamps the used-%', () => {
    const view = buildQuotaView(
      [ok({ windows: [{ label: 'a', usedPct: 76.6, resetsAt: null }, { label: 'b', usedPct: 140, resetsAt: null }] })],
      80,
      NOW,
    );
    expect(view.rows[0]!.windows.map((w) => w.usedPct)).toEqual([77, 100]);
  });
});
