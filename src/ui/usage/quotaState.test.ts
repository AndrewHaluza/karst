import { describe, it, expect } from 'vitest';
import { buildQuotaView, QUOTA_STALE_MS } from './quotaState.js';
import { QUOTA_EXPIRED_TEXT } from '../../model/quotaText.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ok = (overrides: Partial<Extract<QuotaSnapshot, { state: 'ok' }>> = {}): QuotaSnapshot => ({
  core: 'codex',
  state: 'ok',
  windows: [
    { label: '7-day', usedPct: 76, resetsAt: iso(2 * HOUR) },
  ],
  source: 'Codex session rate limits',
  readAt: iso(-3 * 60_000),
  ...overrides,
});

describe('buildQuotaView', () => {
  it('builds a row per snapshot with host-formatted windows', () => {
    const view = buildQuotaView([ok()], 80, NOW);
    expect(view.thresholdPct).toBe(80);
    expect(view.anyNear).toBe(false);
    expect(view.subtitle).toBe('Warn at 80% used');
    expect(view.summaryLine).toBeNull();
    const row = view.rows[0]!;
    expect(row).toMatchObject({ core: 'codex', label: 'Codex', state: 'ok', readAgo: '3m ago' });
    expect(row.readMeta).toBe('Read 3m ago');
    expect(row.windows[0]).toMatchObject({
      label: '7-day',
      usedPct: 76,
      level: 'ok',
      width: '76',
      resetsIn: '2h 0m',
      expired: false,
      meta: 'Resets in 2h 0m',
      levelLabel: null,
      usedDisplay: '76% used',
      ariaLabel: 'Codex 7-day used',
    });
  });

  it('bands a window near the threshold and exhausted at 100, with a word and a glyph word', () => {
    const view = buildQuotaView(
      [ok({ windows: [
        { label: 'a', usedPct: 80, resetsAt: null },
        { label: 'b', usedPct: 100, resetsAt: null },
      ] })],
      80,
      NOW,
    );
    expect(view.rows[0]!.windows.map((w) => w.level)).toEqual(['near', 'exhausted']);
    expect(view.rows[0]!.windows.map((w) => w.levelLabel)).toEqual(['Near limit', 'Limit reached']);
    expect(view.anyNear).toBe(true);
  });

  it('gives a near window one summary line naming the core, window and percent (US-19)', () => {
    const view = buildQuotaView([ok({
      windows: [
        { label: '5-hour', usedPct: 34, resetsAt: iso(2 * HOUR) },
        { label: '7-day', usedPct: 82, resetsAt: iso(4 * DAY) },
      ],
    })], 80, NOW);
    expect(view.anyNear).toBe(true);
    expect(view.summaryLine).toBe('Codex 7-day is at 82% used.');
  });

  it('expires a window whose reset instant passed: no percent, no bar, one sentence (US-3)', () => {
    const view = buildQuotaView(
      [ok({ windows: [{ label: '5-hour', usedPct: 64, resetsAt: iso(-20 * 60_000) }] })],
      80,
      NOW,
    );
    const window = view.rows[0]!.windows[0]!;
    expect(window).toMatchObject({
      expired: true,
      level: 'ok',
      width: '0',
      resetsIn: null,
      meta: QUOTA_EXPIRED_TEXT,
      levelLabel: null,
      usedDisplay: null,
    });
    expect(view.anyNear).toBe(false);
    expect(view.summaryLine).toBeNull();
  });

  it('does not flag anyNear when the only tight window has already expired', () => {
    const view = buildQuotaView(
      [ok({ windows: [{ label: '5-hour', usedPct: 95, resetsAt: iso(-HOUR) }] })],
      80,
      NOW,
    );
    expect(view.anyNear).toBe(false);
  });

  it('words a window with no reset stamp instead of inventing a countdown', () => {
    const view = buildQuotaView([ok({ windows: [{ label: '30-day', usedPct: 10, resetsAt: null }] })], 80, NOW);
    expect(view.rows[0]!.windows[0]!.meta).toBe('No reset time reported');
  });

  it('calls a read older than an hour possibly out of date (US-31)', () => {
    const stale = buildQuotaView([
      ok({ readAt: iso(-4 * DAY), windows: [{ label: '7-day', usedPct: 40, resetsAt: iso(2 * DAY) }] }),
    ], 80, NOW).rows[0]!;
    expect(stale.stale).toBe(true);
    expect(stale.readAgo).toBe('4d ago');
    expect(stale.readMeta).toBe('Read 4d ago · may be out of date');

    const fresh = buildQuotaView([ok({ readAt: iso(-30 * 60_000) })], 80, NOW).rows[0]!;
    expect(fresh.stale).toBe(false);
    expect(fresh.readMeta).toBe('Read 30m ago');
    expect(QUOTA_STALE_MS).toBe(HOUR);
  });

  it('renders an unknown core with a plain reason and keeps the raw text for the tooltip (US-32)', () => {
    const row = buildQuotaView([
      { core: 'claude', state: 'unknown', reason: 'ENOENT /root/.claude/cache/quota.json' },
    ], 80, NOW).rows[0]!;
    expect(row.state).toBe('unknown');
    expect(row.reason).toBe('ENOENT /root/.claude/cache/quota.json');
    expect(row.plainReason).toBe('Claude Code has not written a quota file yet.');
    expect(row.plainReason).not.toContain('/root');
  });

  it('maps each core’s sign-in and rate-limit reasons to one plain sentence', () => {
    const reason = (core: QuotaSnapshot['core'], text: string): string =>
      buildQuotaView([{ core, state: 'unknown', reason: text }], 80, NOW).rows[0]!.plainReason!;
    expect(reason('claude', 'HTTP 401 invalid token')).toBe('Claude Code needs a valid sign-in to read quota.');
    expect(reason('claude', '429 rate limit')).toBe('Claude Code quota API is temporarily rate limited.');
    expect(reason('codex', 'no session file')).toBe('Codex has not recorded a session yet.');
    expect(reason('codex', 'network down')).toBe('Codex quota is not available right now.');
    expect(reason('antigravity', 'anything')).toBe('Antigravity CLI does not expose quota locally.');
    expect(reason('opencode', 'account has no go plan')).toBe('This OpenCode account does not have a Go plan.');
    expect(reason('opencode', 'network down')).toBe('OpenCode quota is not available right now.');
  });

  it('empty snapshots build an empty, titled view (US-13)', () => {
    const view = buildQuotaView([], 80, NOW);
    expect(view.rows).toEqual([]);
    expect(view.anyNear).toBe(false);
    expect(view.subtitle).toBe('Warn at 80% used');
    expect(view.summaryLine).toBeNull();
  });

  it('keeps an expired window visible, expired, beside the active one (T1300, D751)', () => {
    const view = buildQuotaView(
      [ok({
        windows: [
          { label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' },
          {
            label: '7-day',
            usedPct: 42,
            resetsAt: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
          },
        ],
      })],
      80,
      NOW,
    );
    const row = view.rows[0]!;
    expect(row.state).toBe('ok');
    expect(row.windows.map((w) => w.label)).toEqual(['5-hour', '7-day']);
    expect(row.windows[0]).toMatchObject({
      expired: true,
      usedDisplay: null,
      width: '0',
      meta: QUOTA_EXPIRED_TEXT,
    });
    expect(row.windows[1]).toMatchObject({ usedPct: 42, level: 'ok', usedDisplay: '42% used' });
    expect(view.anyNear).toBe(false);
  });

  it('keeps an all-expired row readable instead of a stale "resetting now" bar (T1300, D751)', () => {
    const view = buildQuotaView(
      [ok({ windows: [{ label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' }] })],
      80,
      NOW,
    );
    const row = view.rows[0]!;
    expect(row.state).toBe('ok');
    expect(row.windows).toHaveLength(1);
    expect(row.windows[0]).toMatchObject({
      expired: true,
      usedDisplay: null,
      resetsIn: null,
      meta: QUOTA_EXPIRED_TEXT,
    });
    expect(view.anyNear).toBe(false);
    expect(view.summaryLine).toBeNull();
  });

  it('expires a null-reset window once the read outlives its length (T1300, D751)', () => {
    const view = buildQuotaView(
      [ok({
        windows: [{ label: '5-hour', usedPct: 95, resetsAt: null }],
        readAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
      })],
      80,
      NOW,
    );
    expect(view.rows[0]!.windows[0]).toMatchObject({
      expired: true,
      usedDisplay: null,
      meta: QUOTA_EXPIRED_TEXT,
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

  it('keeps exhausted secondary pools visible without flagging anyNear (T1337)', () => {
    const view = buildQuotaView(
      [ok({
        core: 'antigravity',
        windows: [
          { label: '5-hour', usedPct: 50, resetsAt: iso(2 * HOUR) },
          { label: 'Weekly', usedPct: 40, resetsAt: iso(4 * DAY) },
          { label: 'Claude/GPT (Weekly)', usedPct: 100, resetsAt: iso(4 * DAY), secondary: true },
          { label: 'Argon (Weekly)', usedPct: 100, resetsAt: iso(4 * DAY), secondary: true },
        ],
      })],
      80,
      NOW,
    );
    const row = view.rows[0]!;
    expect(row.windows.map((w) => w.label)).toEqual([
      '5-hour',
      'Weekly',
      'Claude/GPT (Weekly)',
      'Argon (Weekly)',
    ]);
    expect(row.windows.map((w) => w.level)).toEqual(['ok', 'ok', 'exhausted', 'exhausted']);
    expect(view.anyNear).toBe(false);
    expect(view.summaryLine).toBeNull();
  });

  it('names the primary window in the summary line, not an exhausted secondary pool (T1337)', () => {
    const view = buildQuotaView(
      [ok({
        core: 'antigravity',
        windows: [
          { label: '5-hour', usedPct: 88, resetsAt: iso(2 * HOUR) },
          { label: 'Weekly', usedPct: 59, resetsAt: iso(4 * DAY) },
          { label: 'Claude/GPT (Weekly)', usedPct: 100, resetsAt: iso(4 * DAY), secondary: true },
          { label: 'Argon (Weekly)', usedPct: 100, resetsAt: iso(4 * DAY), secondary: true },
        ],
      })],
      80,
      NOW,
    );
    expect(view.anyNear).toBe(true);
    expect(view.summaryLine).toBe('Antigravity CLI 5-hour is at 88% used.');
  });

  it('names an open secondary pool in the summary line only when no primary window is open (T1337)', () => {
    const view = buildQuotaView(
      [ok({
        core: 'antigravity',
        windows: [
          { label: 'Claude/GPT (Weekly)', usedPct: 100, resetsAt: iso(4 * DAY), secondary: true },
        ],
      })],
      80,
      NOW,
    );
    expect(view.anyNear).toBe(true);
    expect(view.summaryLine).toBe('Antigravity CLI Claude/GPT (Weekly) is at 100% used.');
  });
});

describe('buildQuotaView — account name (D505)', () => {
  it('appends the account to the core label only when one is given, and names the meter with it', () => {
    const snap = { core: 'claude', state: 'unknown', reason: 'x' } as unknown as Parameters<typeof buildQuotaView>[0][number];
    expect(buildQuotaView([snap], 80, new Date(), () => 'work').rows[0]?.label).toMatch(/ · work$/);
    expect(buildQuotaView([snap], 80, new Date(), () => undefined).rows[0]?.label).not.toContain('·');

    const view = buildQuotaView([ok()], 80, NOW, () => 'work');
    expect(view.rows[0]!.windows[0]!.ariaLabel).toBe('Codex · work 7-day used');
  });
});
