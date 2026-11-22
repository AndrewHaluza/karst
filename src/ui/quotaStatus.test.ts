import { describe, it, expect } from 'vitest';
import { buildQuotaIndicator } from './quotaStatus.js';
import type { QuotaSnapshot } from '../agent/quota/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const label = (core: string): string => core;

const ok = (core: QuotaSnapshot['core'], used: number, resetsAt: string | null = null): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt }],
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

const unknown = (core: QuotaSnapshot['core']): QuotaSnapshot => ({ core, state: 'unknown', reason: 'nope' });

describe('buildQuotaIndicator', () => {
  it('is null when no core has a readable window', () => {
    expect(buildQuotaIndicator([], 80, label, NOW)).toBeNull();
    expect(buildQuotaIndicator([unknown('codex')], 80, label, NOW)).toBeNull();
  });

  it('shows the tightest used-% per known core and hides unknown ones', () => {
    const indicator = buildQuotaIndicator(
      [ok('claude', 34), ok('codex', 76), unknown('opencode')],
      80,
      label,
      NOW,
    );
    expect(indicator?.text).toBe('$(dashboard) claude 34% · codex 76%');
    expect(indicator?.level).toBe('ok');
  });

  it('is near at or above the threshold, with the warning glyph', () => {
    const indicator = buildQuotaIndicator([ok('codex', 80)], 80, label, NOW);
    expect(indicator?.level).toBe('near');
    expect(indicator?.text).toBe('$(warning) codex 80%');
  });

  it('is exhausted at 100%, with the error glyph', () => {
    const indicator = buildQuotaIndicator([ok('codex', 100)], 80, label, NOW);
    expect(indicator?.level).toBe('exhausted');
    expect(indicator?.text).toBe('$(error) codex 100%');
  });

  it('lets one exhausted window win over a merely near one', () => {
    const mixed: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [
        { label: '5-hour', usedPct: 85, resetsAt: '2026-01-02T00:00:00.000Z' },
        { label: '7-day', usedPct: 100, resetsAt: '2026-01-08T00:00:00.000Z' },
      ],
      source: 'test',
      readAt: '2026-01-01T00:00:00.000Z',
    };
    expect(buildQuotaIndicator([mixed], 80, label, NOW)?.level).toBe('exhausted');
  });

  it('names each window and the threshold in the tooltip', () => {
    const indicator = buildQuotaIndicator(
      [ok('codex', 76, '2026-01-02T00:00:00.000Z')],
      80,
      label,
      NOW,
    );
    expect(indicator?.tooltip).toContain('codex: 7-day: 76% used · Resets in 1d 0h');
    expect(indicator?.tooltip).toContain('Warn at 80% used');
  });

  it('drops a window whose reset instant has already passed', () => {
    const indicator = buildQuotaIndicator([ok('codex', 95, '2025-12-25T00:00:00.000Z')], 80, label, NOW);
    expect(indicator).toBeNull();
  });

  it('names an all-expired core in the tooltip but never in the badge text (US-3)', () => {
    const expired: QuotaSnapshot = ok('codex', 95, '2025-12-25T00:00:00.000Z');
    const indicator = buildQuotaIndicator(
      [expired, ok('claude', 20, '2026-01-03T00:00:00.000Z')],
      80,
      label,
      NOW,
    );
    expect(indicator?.text).toBe('$(dashboard) claude 20%');
    expect(indicator?.level).toBe('ok');
    expect(indicator?.tooltip).toContain('codex: Reset · waiting for a new read');
    expect(indicator?.tooltip).not.toContain('codex: 7-day: 95%');
  });

  it('keeps a core whose open window is below threshold when its tighter one expired', () => {
    const mixed: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [
        { label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' },
        { label: '7-day', usedPct: 20, resetsAt: '2026-01-03T00:00:00.000Z' },
      ],
      source: 'test',
      readAt: '2025-12-25T00:00:00.000Z',
    };
    const indicator = buildQuotaIndicator([mixed], 80, label, NOW);
    expect(indicator?.text).toBe('$(dashboard) codex 20%');
    expect(indicator?.level).toBe('ok');
    // The core is not all-expired, so it gets its open-window line only.
    expect(indicator?.tooltip).not.toContain('Reset · waiting for a new read');
  });
});

describe('buildQuotaIndicator — account name (D505, US-30)', () => {
  const snap = {
    core: 'claude',
    state: 'ok',
    readAt: '2026-01-01T00:00:00Z',
    source: 's',
    windows: [{ label: '5h', usedPct: 40, resetsAt: null }],
  } as unknown as Parameters<typeof buildQuotaIndicator>[0][number];
  const now = new Date('2026-01-01T00:01:00Z');

  it('shows the account beside the core with the shared separator', () => {
    const r = buildQuotaIndicator([snap], 80, () => 'Claude', now, () => 'work');
    expect(r?.text).toContain('Claude · work 40%');
    expect(r?.tooltip).toContain('Claude · work: 5h: 40% used');
  });

  it('shows no account when none is given', () => {
    expect(buildQuotaIndicator([snap], 80, () => 'Claude', now, () => undefined)?.text).toContain(
      'Claude 40%',
    );
  });
});
