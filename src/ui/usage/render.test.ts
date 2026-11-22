// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import {
  usageRenderFixtures,
  USAGE_SCENARIOS,
} from './renderFixtures.js';
import { QUOTA_EXPIRED_TEXT } from '../../model/quotaText.js';
import { usageErrorState } from './state.js';

const FIXTURE_NONCE = 'fixture-nonce-000000000000';

function open(scenario: (typeof USAGE_SCENARIOS)[number]) {
  const fixture = usageRenderFixtures().find((f) => f.scenario === scenario)!;
  const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
  h.receive({ type: 'state', state: fixture.state });
  return { h, fixture };
}

function lastPosted(h: ReturnType<typeof renderWebview>): unknown {
  return h.posted[h.posted.length - 1];
}

describe('usage render', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-03-10T10:42:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  const fixtures = usageRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing and with no realm error', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.errors).toEqual([]);
        } finally { h.close(); }
      });

      it('shows the empty state when empty and no error', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          const emptyVisible = !h.query('#empty')!.classList.contains('hidden');
          const bodyVisible = !h.query('#body')!.classList.contains('hidden');
          if (fixture.state.tab === 'spend' && fixture.state.empty && !fixture.state.error) {
            expect(emptyVisible).toBe(true);
            expect(bodyVisible).toBe(false);
          } else {
            expect(emptyVisible).toBe(false);
          }
        } finally { h.close(); }
      });

      it('hides the loading skeleton once a state arrives (US-12)', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          expect(h.query('#loading')!.classList.contains('hidden')).toBe(false);
          h.receive({ type: 'state', state: fixture.state });
          expect(h.query('#loading')!.classList.contains('hidden')).toBe(true);
        } finally { h.close(); }
      });

      it('renders one ticket row per entry on the spend tab', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.tab === 'spend' && !fixture.state.empty && !fixture.state.error) {
            expect(h.queryAll('#tbody tr')).toHaveLength(fixture.state.tickets.length);
          }
        } finally { h.close(); }
      });

      it('renders every breakdown row', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.tab === 'spend' && !fixture.state.empty && !fixture.state.error) {
            expect(h.queryAll('#providers .brow')).toHaveLength(fixture.state.byProvider.length);
            expect(h.queryAll('#activities .brow')).toHaveLength(fixture.state.byActivity.length);
            expect(h.queryAll('#models .brow')).toHaveLength(fixture.state.byModel.length);
            expect(h.queryAll('#profiles .brow')).toHaveLength(fixture.state.byProfile.length);
          }
        } finally { h.close(); }
      });

      it('clicking a ticket row posts open-dashboard with ticketId', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          if (fixture.state.tab === 'spend' && !fixture.state.empty && !fixture.state.error) {
            const btn = h.query('#tbody [data-ticket]');
            if (btn) {
              const before = h.posted.length;
              (btn as HTMLElement).click();
              expect(h.posted.length).toBe(before + 1);
              expect(h.posted[before]).toMatchObject({ type: 'open-dashboard' });
            }
          }
        } finally { h.close(); }
      });

      it('snapshot', () => {
        const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
        try {
          h.receive({ type: 'state', state: fixture.state });
          expect(h.document.body.innerHTML).toMatchSnapshot();
        } finally { h.close(); }
      });
    });
  }

  describe('page header, scope and updated label (US-1, US-11, US-33)', () => {
    it('renders the shared page header with the host scope label and cost note', () => {
      const { h, fixture } = open('single-page');
      try {
        const head = h.query('.k-pagehead')!;
        expect(head.querySelector('.k-pagehead-title')!.textContent).toBe('Token usage');
        expect(h.query('#sub')!.textContent).toBe(fixture.state.scopeLabel);
        expect(h.query('#sub')!.textContent).toBe('All time · since Feb 14, 2026');
        expect(h.query('#updated')!.textContent).toBe('Updated 10:42');
        expect(h.query('#statsNotes')!.textContent).toContain('Tokens, not cost');
        expect(h.query('#statsNotes')!.textContent).toContain('Fresh = input + output + reasoning + cache write');
      } finally { h.close(); }
    });

    it('shows "All time" when nothing was recorded', () => {
      const { h } = open('empty');
      try {
        expect(h.query('#sub')!.textContent).toBe('All time');
      } finally { h.close(); }
    });

    it('prints each known agent core with its canonical mark (@ui:SG-25)', () => {
      const { h } = open('single-page');
      try {
        expect(h.queryAll('#providers .agentbadge').length).toBeGreaterThan(0);
        expect(h.query('#providers .agentbadge')!.textContent).toContain('Claude Code');
        // The unreported/folded rows stay plain text.
        expect(h.query('#providers .lbl')!.textContent).toBeTruthy();
      } finally { h.close(); }
    });

    it('renders the cache-write tile and the fresh headline (US-6)', () => {
      const { h } = open('single-page');
      try {
        expect(h.query('.stat--hero')!.textContent).toContain('Fresh tokens');
        expect(h.query('.stat--hero')!.textContent).toContain('1,000,000 tokens');
        expect(h.query('#stats')!.textContent).toContain('Cache write');
        expect(h.query('#stats')!.textContent).toContain('counted in fresh');
        expect(h.query('#stats')!.textContent).toContain('not in fresh');
      } finally { h.close(); }
    });

    it('separates the exact token count from the estimate note in the hero (UI-R31)', () => {
      const { h, fixture } = open('single-page');
      try {
        const t = fixture.state.totals;
        expect(t.estimatedNote).not.toBeNull();
        expect(h.query('.stat--hero .n')!.textContent).toBe(`${t.totalNote} · ${t.estimatedNote}`);
      } finally { h.close(); }
    });

    it('shows the true group count beside a capped panel, agreeing with its accessible name (UI-R31)', () => {
      const { h, fixture } = open('hostile');
      try {
        expect(fixture.state.byModel.length).toBeLessThan(fixture.state.counts.modelCount);
        expect(h.query('#modelCount')!.textContent).toBe(String(fixture.state.counts.modelCount));
        expect(h.query('#modelCount')!.getAttribute('aria-label')).toBe(fixture.state.counts.models);
      } finally { h.close(); }
    });
  });

  describe('tabs and focus (US-21, US-24)', () => {
    it('renders tab semantics with the selected tab and its panel', () => {
      const { h } = open('quota-near');
      try {
        const tabs = h.queryAll('#tabs [role="tab"]');
        expect(tabs).toHaveLength(2);
        expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
        expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
        expect(tabs[1]!.getAttribute('aria-controls')).toBe('quota');
        expect(h.query('#quota')!.getAttribute('role')).toBe('tabpanel');
        expect(h.query('#quota')!.classList.contains('hidden')).toBe(false);
        expect(h.query('#spend')!.classList.contains('hidden')).toBe(true);
      } finally { h.close(); }
    });

    it('arrow keys move and activate the next tab', () => {
      const { h } = open('single-page');
      try {
        const spend = h.query('#tab-spend') as HTMLElement;
        spend.focus();
        h.query('#tabs')!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect((h.document.activeElement as HTMLElement).dataset.tab).toBe('quota');
        expect(lastPosted(h)).toMatchObject({ type: 'set-tab', tab: 'quota' });
      } finally { h.close(); }
    });

    it('puts focus back on the sort control after a re-render (US-24)', () => {
      const { h, fixture } = open('single-page');
      try {
        const calls = h.query('[data-sort="calls"]') as HTMLElement;
        calls.focus();
        calls.click();
        h.receive({ type: 'state', state: { ...fixture.state, sort: 'calls' } });
        expect((h.document.activeElement as HTMLElement).dataset.sort).toBe('calls');
      } finally { h.close(); }
    });
  });

  describe('the by-ticket table (US-8, US-16, US-25, US-26, US-35)', () => {
    it('renders a real <time> with the host display and tooltip', () => {
      const { h } = open('single-page');
      try {
        const time = h.query('#tbody time')!;
        expect(time).not.toBeNull();
        expect(time.getAttribute('datetime')).toBeTruthy();
        expect(time.getAttribute('title')).toContain('2026');
        expect(time.textContent).toBeTruthy();
      } finally { h.close(); }
    });

    it('keeps the ticket key in its own span and the title in a second one', () => {
      const { h, fixture } = open('long-key');
      try {
        const key = h.query('#tbody .tkt-key')!;
        expect(key.textContent).toBe('FIX-A-SANDBOX-SETUP-FAILURE');
        expect(h.query('#tbody .tkt-title')!.textContent).toContain('name the blocked host (proxy 403)');
        expect(key.closest('[data-ticket]')!.getAttribute('title')).toBe(fixture.state.tickets[0]!.label);
      } finally { h.close(); }
    });

    it('renders a sortable .k-sort button with the descending arrow hidden from AT', () => {
      const { h } = open('single-page');
      try {
        const total = h.query('[data-sort="total"]')!;
        expect(total.className).toBe('k-sort');
        expect(total.getAttribute('aria-label')).toBe('Total, sorted descending');
        expect(total.querySelector('[aria-hidden="true"]')).not.toBeNull();
      } finally { h.close(); }
    });

    it('renders the column priorities and labels for the responsive tiers', () => {
      const { h } = open('single-page');
      try {
        expect(h.queryAll('th[data-priority]')).toHaveLength(6);
        expect(h.queryAll('td[data-priority]').length).toBeGreaterThan(0);
        expect(h.query('td[data-label="Total"]')).not.toBeNull();
      } finally { h.close(); }
    });
  });

  describe('error states (US-2, US-14)', () => {
    it('shows the inline error with a Try again action and does not toast on open', () => {
      const { h, fixture } = open('host-failure');
      try {
        expect(h.query('#err')!.classList.contains('hidden')).toBe(false);
        expect(h.query('#errText')!.textContent).toBe(fixture.state.error);
        expect(h.query('#retryBtn')).not.toBeNull();
        expect(h.query('#k-toast-root')).toBeNull();
      } finally { h.close(); }
    });

    it('toasts an error that follows a user action (US-14)', () => {
      const { h, fixture } = open('host-failure');
      try {
        (h.query('#refreshBtn') as HTMLElement).click();
        h.receive({ type: 'state', state: { ...fixture.state, error: 'A different failure' } });
        expect(h.query('#k-toast-root')).not.toBeNull();
      } finally { h.close(); }
    });

    it('toasts a retry that fails with the SAME message (UI-R27, US-14)', () => {
      const { h, fixture } = open('host-failure');
      try {
        (h.query('#retryBtn') as HTMLElement).click();
        h.receive({ type: 'state', state: fixture.state });
        expect(h.query('#k-toast-root')).not.toBeNull();
      } finally { h.close(); }
    });

    it('hides the Quota empty state when the host read failed (UI-R31, US-2)', () => {
      const state = usageErrorState(
        { tab: 'quota', sort: 'calls', offset: 0, limit: 20 },
        'Could not read token usage. Details are in the Karst log.',
        new Date('2026-03-10T10:42:00Z'),
        { locale: 'en-US', timeZone: 'UTC' },
      );
      const h = renderWebview('usage', { nonce: FIXTURE_NONCE });
      try {
        h.receive({ type: 'state', state });
        expect(h.query('#err')!.classList.contains('hidden')).toBe(false);
        expect(h.query('#quotaEmpty')!.classList.contains('hidden')).toBe(true);
        expect(h.query('#qrows')!.classList.contains('hidden')).toBe(true);
      } finally { h.close(); }
    });

    it('the Retry action asks the host for a fresh state', () => {
      const { h } = open('host-failure');
      try {
        const before = h.posted.length;
        (h.query('#retryBtn') as HTMLElement).click();
        expect(h.posted[before]).toMatchObject({ type: 'request-state' });
      } finally { h.close(); }
    });

    it('the header Refresh asks the host for a fresh state', () => {
      const { h } = open('single-page');
      try {
        const before = h.posted.length;
        (h.query('#refreshBtn') as HTMLElement).click();
        expect(h.posted[before]).toMatchObject({ type: 'request-state' });
      } finally { h.close(); }
    });
  });

  describe('empty states (US-13, US-15)', () => {
    it('offers Create a ticket on the empty Spend tab', () => {
      const { h } = open('empty');
      try {
        expect(h.query('#empty')!.textContent).toContain('No token usage yet');
        const before = h.posted.length;
        (h.query('#createTicketBtn') as HTMLElement).click();
        expect(h.posted[before]).toMatchObject({ type: 'create-ticket' });
      } finally { h.close(); }
    });

    it('offers Quota settings when no core has a read', () => {
      const { h } = open('quota-empty');
      try {
        expect(h.query('#quotaEmpty')!.classList.contains('hidden')).toBe(false);
        expect(h.query('#quotaEmpty')!.textContent).toContain('No quota read yet');
        const before = h.posted.length;
        (h.query('#quotaSettingsBtn') as HTMLElement).click();
        expect(h.posted[before]).toMatchObject({ type: 'open-quota-settings' });
      } finally { h.close(); }
    });
  });

  describe('the Quota tab (US-3, US-19, US-26, US-30, US-31, US-32)', () => {
    it('renders one card per core and one meter per open window', () => {
      const { h, fixture } = open('quota-near');
      try {
        expect(h.queryAll('#qrows .qrow')).toHaveLength(fixture.state.quota.rows.length);
        const open = fixture.state.quota.rows
          .filter((r) => r.state === 'ok')
          .flatMap((r) => r.windows.filter((w) => !w.expired));
        expect(h.queryAll('#qrows [role="meter"]')).toHaveLength(open.length);
        expect(h.query('#qrows [role="meter"]')!.getAttribute('aria-valuemax')).toBe('100');
        expect(h.query('#qrows [role="meter"]')!.getAttribute('aria-valuemin')).toBe('0');
        expect(h.query('#qrows [role="meter"]')!.getAttribute('aria-valuenow')).toBeTruthy();
      } finally { h.close(); }
    });

    it('shows a near window as a word plus a percent, and one summary line', () => {
      const { h } = open('quota-near');
      try {
        expect(h.query('#qsummary')!.classList.contains('hidden')).toBe(false);
        expect(h.query('#qsummary')!.textContent).toBe('Codex 7-day is at 82% used.');
        expect(h.query('#qrows')!.textContent).toContain('Near limit');
        expect(h.query('#qrows')!.textContent).toContain('82% used');
      } finally { h.close(); }
    });

    it('shows an exhausted window with its word and glyph', () => {
      const { h } = open('quota-exhausted');
      try {
        expect(h.query('#qrows')!.textContent).toContain('Limit reached');
        expect(h.query('#qrows')!.textContent).toContain('100% used');
      } finally { h.close(); }
    });

    it('puts the level word and glyph on the meta line, before the reset text, with the percent alone on the value line (US-19)', () => {
      for (const scenario of ['quota-near', 'quota-exhausted'] as const) {
        const { h } = open(scenario);
        try {
          const win = Array.from(h.queryAll('#qrows .qwin')).find((n) => n.querySelector('.qbadge'))!;
          expect(win, scenario).toBeTruthy();
          const badge = win.querySelector('.qfoot .qbadge')!;
          const meta = win.querySelector('.qfoot .qmeta')!;
          const pct = win.querySelector('.qline .qpct')!;
          expect(badge, scenario).not.toBeNull();
          expect(meta, scenario).not.toBeNull();
          expect(pct, scenario).not.toBeNull();
          // The badge leads the meta line; the reset/age text keeps the right.
          expect([...win.querySelector('.qfoot')!.children].indexOf(badge), scenario).toBeLessThan(
            [...win.querySelector('.qfoot')!.children].indexOf(meta),
          );
          // The status is not on the value line, so the percent is not crowded by it.
          expect(win.querySelector('.qline .qbadge'), scenario).toBeNull();
        } finally { h.close(); }
      }
    });

    it('shows an expired window without a percent, with the one shared sentence (US-3)', () => {
      const { h } = open('quota-expired');
      try {
        expect(h.query('#qrows')!.textContent).not.toContain('64% used');
        expect(h.query('#qrows')!.textContent).not.toContain('resetting now');
        expect(h.query('#qrows')!.textContent).toContain(QUOTA_EXPIRED_TEXT);
        expect(h.query('#qrows [role="meter"]')!.getAttribute('aria-valuenow')).toBe('0');
      } finally { h.close(); }
    });

    it('names a stale read as possibly out of date', () => {
      const { h } = open('quota-stale');
      try {
        expect(h.query('#qrows')!.textContent).toContain('Read 4d ago · may be out of date');
      } finally { h.close(); }
    });

    it('shows an unknown core as Quota not available with a plain reason and the raw text as a tooltip', () => {
      const { h } = open('quota-near');
      try {
        const row = Array.from(h.queryAll('#qrows .qrow')).find((n) => n.textContent?.includes('Antigravity CLI'))!;
        expect(row.textContent).toContain('Quota not available');
        expect(row.textContent).toContain('Antigravity CLI does not expose quota locally.');
        expect(row.textContent).not.toContain('/root');
      } finally { h.close(); }
    });

    it('keeps the core\'s canonical icon on an unknown quota row (UI-R10c)', () => {
      const { h } = open('quota-near');
      try {
        const row = Array.from(h.queryAll('#qrows .qrow')).find((n) => n.textContent?.includes('Antigravity CLI'))!;
        expect(row.querySelector('.qname .agenticon')).not.toBeNull();
        // The generic info glyph is not the core mark.
        expect(row.querySelector('.qname > svg')).toBeNull();
      } finally { h.close(); }
    });

    it('Refresh quota posts refresh-quota', () => {
      const { h } = open('quota-near');
      try {
        const before = h.posted.length;
        (h.query('#refreshQuotaBtn') as HTMLElement).click();
        expect(h.posted[before]).toMatchObject({ type: 'refresh-quota' });
      } finally { h.close(); }
    });

    it('uses the quota subtitle on the Quota tab', () => {
      const { h, fixture } = open('quota-stale');
      try {
        expect(h.query('#sub')!.textContent).toBe(fixture.state.quota.subtitle);
      } finally { h.close(); }
    });
  });

  describe('semantics (US-26)', () => {
    it('renders headings, a main landmark and hidden bar decoration', () => {
      const { h } = open('single-page');
      try {
        expect(h.query('main#main')).not.toBeNull();
        expect(h.queryAll('h2.phead').length).toBeGreaterThanOrEqual(5);
        expect(h.query('#providers')!.closest('.panel')!.querySelector('h2.phead')).not.toBeNull();
        // A breakdown bar is decoration: the number beside it is the answer.
        const bars = h.queryAll('.brow .bar');
        expect(bars.length).toBeGreaterThan(0);
        for (const bar of bars) expect(bar.getAttribute('aria-hidden')).toBe('true');
      } finally { h.close(); }
    });

    it('gives each breakdown panel its host-built count label', () => {
      const { h, fixture } = open('single-page');
      try {
        expect(h.query('#providerCount')!.getAttribute('aria-label')).toBe(fixture.state.counts.providers);
        expect(h.query('#activityCount')!.getAttribute('aria-label')).toBe(fixture.state.counts.activities);
        expect(h.query('#tktCount')!.getAttribute('aria-label')).toBe(fixture.state.counts.tickets);
      } finally { h.close(); }
    });
  });
});
