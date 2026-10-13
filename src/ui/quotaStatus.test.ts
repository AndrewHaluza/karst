import { describe, it, expect } from 'vitest';
import { buildQuotaIndicator } from './quotaStatus.js';
import type { QuotaSnapshot } from '../agent/quota/types.js';

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
    expect(buildQuotaIndicator([], 80, label)).toBeNull();
    expect(buildQuotaIndicator([unknown('codex')], 80, label)).toBeNull();
  });

  it('shows the tightest used-% per known core and hides unknown ones', () => {
    const indicator = buildQuotaIndicator(
      [ok('claude', 34), ok('codex', 76), unknown('opencode')],
      80,
      label,
    );
    expect(indicator?.text).toBe('$(dashboard) claude 34% · codex 76%');
    expect(indicator?.warning).toBe(false);
  });

  it('turns amber at or above the threshold', () => {
    const indicator = buildQuotaIndicator([ok('codex', 80)], 80, label);
    expect(indicator?.warning).toBe(true);
  });

  it('names each window and the threshold in the tooltip', () => {
    const indicator = buildQuotaIndicator([ok('codex', 76, '2026-01-02T00:00:00.000Z')], 80, label);
    expect(indicator?.tooltip).toContain('codex: 76% of 7-day · resets 2026-01-02T00:00:00.000Z');
    expect(indicator?.tooltip).toContain('Warn threshold 80%');
  });
});
