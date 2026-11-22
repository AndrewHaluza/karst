import { describe, it, expect } from 'vitest';
import { isWindowExpired, type QuotaWindow } from '../agent/quota/types.js';
import {
  QUOTA_EXPIRED_TEXT,
  formatAge,
  formatCountdown,
  quotaCoreLabel,
  quotaExpiredTooltipLine,
  quotaWarnThresholdText,
  quotaWindowMeta,
  quotaWindowPct,
  quotaWindowSummary,
  quotaWindowTooltipLine,
} from './quotaText.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const READ_AT = '2026-01-01T00:00:00.000Z';

function window(over: Partial<QuotaWindow> = {}): QuotaWindow {
  return { label: '5-hour', usedPct: 34, resetsAt: '2026-01-01T02:13:00.000Z', ...over };
}

describe('formatAge', () => {
  it('buckets a positive age', () => {
    expect(formatAge(30_000)).toBe('just now');
    expect(formatAge(3 * 60_000)).toBe('3m ago');
    expect(formatAge(2 * 3_600_000)).toBe('2h ago');
    expect(formatAge(4 * 24 * 3_600_000)).toBe('4d ago');
  });

  it('clamps a negative age to just now', () => {
    expect(formatAge(-5_000)).toBe('just now');
  });
});

describe('formatCountdown', () => {
  it('prints seconds, minutes, hours and days', () => {
    expect(formatCountdown(30_000)).toBe('30s');
    expect(formatCountdown(13 * 60_000)).toBe('13m');
    expect(formatCountdown(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m');
    expect(formatCountdown(2 * 24 * 3_600_000 + 3 * 3_600_000)).toBe('2d 3h');
  });

  it('returns null once the instant has passed', () => {
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-1_000)).toBeNull();
  });
});

describe('quotaWindowMeta', () => {
  it('counts down to a future reset', () => {
    expect(quotaWindowMeta(window(), NOW, READ_AT)).toBe('Resets in 2h 13m');
  });

  it('says so when the provider reported no reset instant', () => {
    expect(quotaWindowMeta(window({ resetsAt: null }), NOW, READ_AT)).toBe(
      'No reset time reported',
    );
    expect(quotaWindowMeta(window({ resetsAt: 'not a date' }), NOW, READ_AT)).toBe(
      'No reset time reported',
    );
  });

  it('uses the one expired sentence once resetsAt has passed', () => {
    expect(
      quotaWindowMeta(window({ resetsAt: '2025-12-31T23:59:00.000Z' }), NOW, READ_AT),
    ).toBe(QUOTA_EXPIRED_TEXT);
  });

  it('uses the one expired sentence when the window expires by snapshot age', () => {
    // A 5-hour window with no stamp expires once the read is older than 5h.
    expect(
      quotaWindowMeta(
        window({ resetsAt: null }),
        NOW,
        '2025-12-31T10:00:00.000Z',
      ),
    ).toBe(QUOTA_EXPIRED_TEXT);
  });
});

describe('shared quota wording (US-28, US-30)', () => {
  it('names a core with its active account', () => {
    expect(quotaCoreLabel('Claude Code', 'work')).toBe('Claude Code · work');
    expect(quotaCoreLabel('Claude Code')).toBe('Claude Code');
  });

  it('words a window percentage', () => {
    expect(quotaWindowPct(34)).toBe('34% used');
    expect(quotaWindowPct(33.6)).toBe('34% used');
    expect(quotaWindowSummary('5-hour', 34)).toBe('5-hour: 34% used');
  });

  it('words the warn threshold', () => {
    expect(quotaWarnThresholdText(80)).toBe('Warn at 80% used');
  });

  it('words an all-expired core', () => {
    expect(quotaExpiredTooltipLine('Codex')).toBe(`Codex: ${QUOTA_EXPIRED_TEXT}`);
  });

  it('words one open window tooltip line', () => {
    expect(quotaWindowTooltipLine('Codex', window(), NOW, READ_AT)).toBe(
      'Codex: 5-hour: 34% used · Resets in 2h 13m',
    );
  });
});

describe('expiry parity with the agent predicate', () => {
  // `src/model` may not value-import `src/agent` (core-agent-seam), so
  // `quotaWindowMeta` carries a local copy of `isWindowExpired`. Test files are
  // outside that rule, so this table is the pin that stops the two drifting.
  const now = new Date('2026-01-01T00:00:00.000Z');
  const cases: Array<{ window: QuotaWindow; readAt?: string }> = [
    { window: { label: '5-hour', usedPct: 10, resetsAt: '2026-01-01T02:13:00.000Z' } },
    { window: { label: '5-hour', usedPct: 10, resetsAt: '2025-12-31T23:59:00.000Z' } },
    { window: { label: '5-hour', usedPct: 10, resetsAt: 'not a date' } },
    { window: { label: '5-hour', usedPct: 10, resetsAt: null }, readAt: '2026-01-01T00:00:00.000Z' },
    { window: { label: '5-hour', usedPct: 10, resetsAt: null }, readAt: '2025-12-31T10:00:00.000Z' },
    { window: { label: '7-day', usedPct: 10, resetsAt: null }, readAt: '2025-12-31T10:00:00.000Z' },
    { window: { label: 'Weekly', usedPct: 10, resetsAt: null }, readAt: '2025-01-01T00:00:00.000Z' },
    { window: { label: '5-hour', usedPct: 10, resetsAt: null }, readAt: 'bad' },
  ];

  it('agrees with isWindowExpired on every case', () => {
    for (const { window: w, readAt } of cases) {
      const expired = isWindowExpired(w, now, readAt);
      const meta = quotaWindowMeta(w, now, readAt);
      const label = JSON.stringify({ w, readAt });
      expect(meta === QUOTA_EXPIRED_TEXT, label).toBe(expired);
      if (!expired) expect(meta, label).not.toBe(QUOTA_EXPIRED_TEXT);
    }
  });
});
