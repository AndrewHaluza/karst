import { describe, expect, it } from 'vitest';
import { USAGE_SORTS } from '../../store/tokenUsageQuery.js';
import {
  usageRenderFixtures,
  USAGE_SCENARIOS,
  USAGE_FIXTURE_RAW,
  FIXTURE_NOW,
} from './renderFixtures.js';
import { formatExactTokens, formatShare, formatTokens } from '../../model/tokenFormat.js';
import { formatCalendarDate, formatFullDateTime } from '../../model/dateText.js';
import { QUOTA_EXPIRED_TEXT } from '../../model/quotaText.js';

const DATE_OPTS = { locale: 'en-US', timeZone: 'UTC' } as const;

/**
 * Data-contract tests for the usage render fixture corpus.
 * Pins deterministic identity, ordering, per-scenario invariants, vocabulary
 * coverage, hostile-string presence, inert ids, and US-9: every display string
 * is the formatter's output for its raw value.
 */
describe('usage render fixtures', () => {
  const fixtures = usageRenderFixtures();

  it('is deterministic: one fixture per scenario, in USAGE_SCENARIOS order, no duplicates', () => {
    expect(fixtures).toHaveLength(USAGE_SCENARIOS.length);
    const ids = fixtures.map((f) => f.scenario);
    expect(ids).toEqual([...USAGE_SCENARIOS]);
    expect(new Set(ids).size).toBe(fixtures.length);
    expect(JSON.stringify(fixtures)).toBe(JSON.stringify(usageRenderFixtures()));
  });

  it('every scenario is present, including the real-data and state cases of this ticket', () => {
    expect([...USAGE_SCENARIOS]).toEqual([
      'empty',
      'single-page',
      'paged-middle',
      'error',
      'all-sorts',
      'hostile',
      'long-key',
      'host-failure',
      'quota-near',
      'quota-exhausted',
      'quota-expired',
      'quota-stale',
      'quota-empty',
    ]);
  });

  it('empty has empty === true and every row list length 0', () => {
    const empty = fixtures.find((f) => f.scenario === 'empty')!;
    expect(empty.state.empty).toBe(true);
    expect(empty.state.byProvider).toHaveLength(0);
    expect(empty.state.byActivity).toHaveLength(0);
    expect(empty.state.byModel).toHaveLength(0);
    expect(empty.state.byProfile).toHaveLength(0);
    expect(empty.state.tickets).toHaveLength(0);
    expect(empty.state.scopeLabel).toBe('All time');
  });

  it('paged-middle has page.hasPrev && page.hasNext', () => {
    const mid = fixtures.find((f) => f.scenario === 'paged-middle')!;
    expect(mid.state.page.hasPrev).toBe(true);
    expect(mid.state.page.hasNext).toBe(true);
    expect(mid.state.page.offset).toBe(10);
  });

  it('error and host-failure have a stated error; every other scenario has none', () => {
    for (const f of fixtures) {
      if (f.scenario === 'error' || f.scenario === 'host-failure') {
        expect(f.state.error, f.scenario).not.toBeNull();
      } else {
        expect(f.state.error, f.scenario).toBeNull();
      }
    }
    expect(fixtures.find((f) => f.scenario === 'error')!.state.error).toBe(
      'fixture: Page offset 40 is past the last page',
    );
    expect(fixtures.find((f) => f.scenario === 'host-failure')!.state.error).toBe(
      'Could not read token usage. Details are in the Karst log.',
    );
  });

  it('every UsageTicketRowView.ticketId is in the reserved band 900001–999999 or null', () => {
    for (const f of fixtures) {
      for (const t of f.state.tickets) {
        if (t.ticketId !== null) {
          expect(t.ticketId, `${f.scenario} ticket id`).toBeGreaterThanOrEqual(900001);
          expect(t.ticketId, `${f.scenario} ticket id`).toBeLessThanOrEqual(999999);
        }
      }
    }
  });

  it('all-sorts fixture carries every UsageSort member in its sorts array', () => {
    const allSorts = fixtures.find((f) => f.scenario === 'all-sorts')!;
    const sortIds = allSorts.state.sorts.map((s) => s.id);
    for (const key of USAGE_SORTS) {
      expect(sortIds, `missing sort: ${key}`).toContain(key);
    }
  });

  it('the one raw dataset spans 120 tokens to a 3.4M cache read and sums to 1,000,000 fresh', () => {
    const rows = USAGE_FIXTURE_RAW.rows;
    const inputValues = rows.map((r) => r.input);
    expect(Math.min(...inputValues)).toBe(USAGE_FIXTURE_RAW.minRawTokens);
    expect(Math.max(...rows.map((r) => r.cacheRead))).toBe(USAGE_FIXTURE_RAW.maxCacheRead);
    const fresh = rows.reduce((sum, r) => sum + r.input + r.output + r.reasoning + r.cacheWrite, 0);
    expect(fresh).toBe(USAGE_FIXTURE_RAW.freshTotal);
    expect(new Set(rows.map((r) => r.core)).size).toBe(3);
    expect(new Set(rows.map((r) => r.model)).size).toBe(4);
    expect(new Set(rows.map((r) => r.activity)).size).toBe(6);
    expect(rows).toHaveLength(25);
  });

  it('every display string is the formatter output for its raw value (US-9)', () => {
    for (const f of fixtures) {
      const totalFresh = Number(f.state.totals.totalExact.replace(/,/g, ''));
      for (const row of [...f.state.byProvider, ...f.state.byActivity, ...f.state.byModel, ...f.state.byProfile]) {
        expect(row.totalDisplay, `${f.scenario} ${row.key}`).toBe(formatTokens(row.totalTokens));
        expect(row.totalExact, `${f.scenario} ${row.key}`).toBe(formatExactTokens(row.totalTokens));
        expect(row.share, `${f.scenario} ${row.key}`).toBe(
          totalFresh === 0 ? 0 : Math.round((row.totalTokens / totalFresh) * 1000) / 10,
        );
        expect(row.shareDisplay, `${f.scenario} ${row.key}`).toBe(
          formatShare(row.totalTokens, totalFresh),
        );
      }
      for (const t of f.state.tickets) {
        expect(t.totalDisplay, `${f.scenario} ${t.label}`).toBe(formatTokens(t.totalTokens));
        expect(t.totalExact, `${f.scenario} ${t.label}`).toBe(formatExactTokens(t.totalTokens));
        const at = t.lastAt!;
        expect(t.lastDisplay).toBe(formatCalendarDate(at, FIXTURE_NOW, DATE_OPTS));
        expect(t.lastTitle).toBe(formatFullDateTime(at, DATE_OPTS));
      }
    }
  });

  it('has no float artefact and no real row printed as 0k (US-9)', () => {
    for (const f of fixtures) {
      const rowStrings = [
        f.state.totals.totalDisplay,
        f.state.totals.inputDisplay,
        f.state.totals.outputDisplay,
        ...f.state.byProvider.flatMap((r) => [r.totalDisplay, r.inputDisplay, r.outputDisplay]),
        ...f.state.tickets.flatMap((t) => [t.totalDisplay, t.inputDisplay, t.outputDisplay]),
      ];
      for (const value of rowStrings) {
        expect(value, `${f.scenario}: ${value}`).not.toMatch(/\d\.\d{3,}/);
      }
      for (const row of [...f.state.byProvider, ...f.state.byActivity, ...f.state.byModel]) {
        if (row.totalTokens > 0) expect(row.totalDisplay, `${f.scenario} ${row.key}`).not.toBe('0k');
      }
    }
  });

  it('the totals equal the rows and each breakdown’s shares add to 100 (US-9)', () => {
    for (const scenario of ['single-page', 'all-sorts', 'long-key', 'hostile']) {
      const state = fixtures.find((f) => f.scenario === scenario)!.state;
      const totalFresh = Number(state.totals.totalExact.replace(/,/g, ''));
      const ticketSum = state.tickets.reduce((sum, t) => sum + t.totalTokens, 0);
      // single-page/all-sorts/long-key fit every row on one page; hostile does too.
      expect(ticketSum, scenario).toBe(totalFresh);
      for (const rows of [state.byProvider, state.byActivity, state.byModel, state.byProfile]) {
        const sum = rows.reduce((acc, r) => acc + r.totalTokens, 0);
        expect(sum, `${scenario} breakdown sum`).toBe(totalFresh);
        const shares = rows.reduce((acc, r) => acc + r.share, 0);
        expect(Math.abs(shares - 100), `${scenario} shares`).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it('hostile contains the untrusted strings, a >=300-char label and a capped model list', () => {
    const hostile = fixtures.find((f) => f.scenario === 'hostile')!;
    const allText = [
      ...hostile.state.byActivity.map((r) => `${r.label} ${r.note ?? ''}`),
      ...hostile.state.byModel.map((r) => r.label),
      ...hostile.state.tickets.map((t) => t.label),
    ].join(' ');
    expect(allText).toContain('<script>alert(1)</script>');
    expect(allText).toContain('A & B "quoted" <b>');
    expect(allText.length).toBeGreaterThan(300);
    expect(hostile.state.counts.models).toBe('12 models');
    expect(hostile.state.byModel).toHaveLength(7);
    expect(hostile.state.byModel[6]).toMatchObject({ key: '__other__', label: 'Other (6)' });
  });

  it('long-key carries the real key and title, with the key unbroken and the title separate (US-35)', () => {
    const state = fixtures.find((f) => f.scenario === 'long-key')!.state;
    const row = state.tickets.find((t) => t.ticketKey === 'FIX-A-SANDBOX-SETUP-FAILURE')!;
    expect(row).toBeDefined();
    expect(row.ticketTitle).toContain("name the blocked host (proxy 403)");
    expect(row.label.startsWith('FIX-A-SANDBOX-SETUP-FAILURE — ')).toBe(true);
  });

  it('quota-near is built through buildQuotaView: Codex at 82%, an unknown core and one summary line', () => {
    const state = fixtures.find((f) => f.scenario === 'quota-near')!.state;
    expect(state.tab).toBe('quota');
    expect(state.quota.subtitle).toBe('Warn at 80% used');
    expect(state.quota.anyNear).toBe(true);
    expect(state.quota.summaryLine).toBe('Codex 7-day is at 82% used.');
    expect(state.quota.rows.map((r) => r.core)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    const codex = state.quota.rows.find((r) => r.core === 'codex')!;
    expect(codex.windows[0]).toMatchObject({ label: '7-day', usedPct: 82, level: 'near', levelLabel: 'Near limit' });
    const unknown = state.quota.rows.find((r) => r.core === 'antigravity')!;
    expect(unknown.state).toBe('unknown');
    expect(unknown.plainReason).toBe('Antigravity CLI does not expose quota locally.');
    const opencode = state.quota.rows.find((r) => r.core === 'opencode')!;
    expect(opencode.windows.map((w) => [w.label, w.usedPct])).toEqual([
      ['5-hour', 3],
      ['Weekly', 9],
      ['Monthly', 45],
    ]);
  });

  it('quota-exhausted has one 100% window with a word and a glyph, not colour only (US-19)', () => {
    const state = fixtures.find((f) => f.scenario === 'quota-exhausted')!.state;
    const window = state.quota.rows[0]!.windows[0]!;
    expect(window).toMatchObject({ label: '5-hour', usedPct: 100, level: 'exhausted', levelLabel: 'Limit reached' });
  });

  it('quota-expired shows no percent and one sentence (US-3)', () => {
    const state = fixtures.find((f) => f.scenario === 'quota-expired')!.state;
    const window = state.quota.rows[0]!.windows[0]!;
    expect(window.expired).toBe(true);
    expect(window.usedDisplay).toBeNull();
    expect(window.meta).toBe(QUOTA_EXPIRED_TEXT);
    expect(state.quota.anyNear).toBe(false);
  });

  it('quota-stale calls the four-day-old read possibly out of date (US-31)', () => {
    const state = fixtures.find((f) => f.scenario === 'quota-stale')!.state;
    const row = state.quota.rows[0]!;
    expect(row.stale).toBe(true);
    expect(row.readMeta).toBe('Read 4d ago · may be out of date');
  });

  it('quota-empty has no rows and still explains the empty state (US-13)', () => {
    const state = fixtures.find((f) => f.scenario === 'quota-empty')!.state;
    expect(state.quota.rows).toEqual([]);
    expect(state.quota.subtitle).toBe('Warn at 80% used');
  });

  it('single-page formats the scope label and the updated label from the fixed clock', () => {
    const state = fixtures.find((f) => f.scenario === 'single-page')!.state;
    expect(state.scopeLabel).toBe('All time · since Feb 14, 2026');
    expect(state.updatedLabel).toBe('Updated 10:42');
    expect(state.totals.totalExact).toBe('1,000,000');
    expect(state.totals.totalNote).toBe('1,000,000 tokens');
  });

  it('calling the factory twice returns structurally equal but non-identical arrays', () => {
    const a = usageRenderFixtures();
    const b = usageRenderFixtures();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).not.toBe(b);
  });
});
