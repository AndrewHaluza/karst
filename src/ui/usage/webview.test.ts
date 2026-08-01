import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USAGE_RANGES, USAGE_SORTS } from '../../store/tokenUsageQuery.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * Text-level guards on the token-usage webview, for the same reason the
 * dashboard's exist: the file is standalone HTML with no test harness, and it is
 * affordable only because every DECISION is host-side. These pin the parts that
 * would fail SILENTLY — a lost CSP marker, a sort key the host would reject, a
 * number formatted locally, an empty state that renders as zero spend.
 */
describe('token-usage webview.html', () => {
  it('keeps the CSP marker — without it the page ships with no policy', () => {
    expect(HTML).toContain('<!--KARST_CSP-->');
  });

  it('posts only sort keys the host will accept', () => {
    const posted = [...HTML.matchAll(/sort:\s*'([a-z]+)'/g)].map((m) => m[1]);
    const declared = [...HTML.matchAll(/sort:\s*'([a-z]+)'\s*,/g)].map((m) => m[1]);
    for (const key of [...posted, ...declared]) {
      expect(USAGE_SORTS as readonly string[], `unknown sort key: ${key}`).toContain(key);
    }
    // Every sort the store offers is reachable from a column header.
    for (const key of USAGE_SORTS) expect(HTML).toContain(`sort: '${key}'`);
  });

  it('renders the range chips from state, never from a hardcoded list', () => {
    expect(HTML).toContain('state.ranges.map');
    for (const range of USAGE_RANGES) {
      expect(HTML, `range must not be hardcoded: ${range.label}`).not.toContain(
        `>${range.label}<`,
      );
    }
  });

  it('renders pre-formatted counts and never formats a number itself', () => {
    expect(HTML).toContain('totalDisplay');
    expect(HTML).toContain('inputDisplay');
    // The host owns abbreviation and grouping — a local formatter is a second
    // implementation of the rule that would drift.
    expect(HTML).not.toMatch(/toLocaleString\(\s*['"]en-US/);
    expect(HTML).not.toMatch(/\/\s*1000\b/);
    expect(HTML).not.toContain("'k'");
  });

  it('takes bar widths from the host-computed share', () => {
    expect(HTML).toContain('width:${Number(r.share) || 0}%');
    // No local percentage arithmetic — the denominator lives in SQL.
    expect(HTML).not.toMatch(/\/\s*(?:total|state\.totals)/);
  });

  it('shows the empty state instead of a grid of zeroes', () => {
    expect(HTML).toContain('id="empty"');
    expect(HTML).toContain('No AI token usage recorded yet');
    expect(HTML).toContain('state.empty');
  });

  it('never shows the empty state for a REJECTED query — that is a different claim', () => {
    expect(HTML).toContain('state.empty && !state.error');
    expect(HTML).toContain('id="err"');
  });

  it('escapes every interpolated value it renders', () => {
    expect(HTML).toContain('const esc =');
    // Labels and ticket titles are user/board-authored text reaching innerHTML.
    expect(HTML).toContain('esc(r.label)');
    expect(HTML).toContain('esc(t.label)');
  });

  it('posts only the four narrowed message types', () => {
    const types = new Set([...HTML.matchAll(/post\(\{\s*type:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    expect([...types].sort()).toEqual([
      'open-dashboard',
      'request-state',
      'set-page',
      'set-range',
      'set-sort',
    ]);
  });

  it('asks for state on load, so a restored panel is never blank', () => {
    expect(HTML).toContain("post({ type: 'request-state' })");
  });

  it('offers no dashboard link for spend with no ticket', () => {
    expect(HTML).toContain('t.ticketId === null');
    expect(HTML).toContain('class="plain"');
  });

  it('scrolls the wide table inside its own frame, not the page', () => {
    expect(HTML).toContain('class="tscroll"');
    expect(HTML).toMatch(/\.tscroll\{overflow-x:auto\}/);
  });
});
