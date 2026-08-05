import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USAGE_RANGES, USAGE_SORTS } from '../../store/tokenUsageQuery.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function styleBlock(): string {
  const start = HTML.indexOf('<style>');
  const end = HTML.indexOf('</style>');
  expect(start, '<style> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</style> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<style>'.length, end);
}

function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

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

  it('carries the design-system markers ahead of any file-local rule (UI-R03)', () => {
    const style = styleBlock();
    expect(style.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
  });

  it('declares no local :root block — tokens come from the injected design system (UI-R04, R05)', () => {
    const style = styleBlock();
    expect(style).not.toContain(':root');
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens (UI-R04)', () => {
    // The old block duplicated 12 now-shared tokens under different names
    // (--border, --hover, --text, --accent, --phead-h:39px, ...) and left
    // ~22 raw px magnitudes scattered through the rest of the sheet. Every
    // length below the marker must now resolve through a --k-* token, a
    // token arithmetic `calc()`, or an explicitly-exempt 0/100%/50%.
    const style = styleBlock();
    const local = style.slice(style.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    const offenders = local.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
  });

  it('does not restyle a bare <button> element — every control is a k- primitive', () => {
    const style = styleBlock();
    expect(style).not.toMatch(/(^|\s|\})button\s*\{/);
    expect(style).not.toMatch(/(^|\s|\})button:hover\s*\{/);
    expect(style).not.toMatch(/(^|\s|\})button:focus-visible\s*\{/);
  });

  it('every static <button> carries a k-btn or k-chip primitive and a variant', () => {
    const buttonTags = [...HTML.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttonTags.length).toBeGreaterThan(0);
    for (const tag of buttonTags) {
      const isChip = /class="[^"]*\bk-chip\b/.test(tag);
      const isBtn = /class="[^"]*\bk-btn\b/.test(tag) && /k-btn--(primary|secondary|ghost|danger|link)/.test(tag);
      expect(isChip || isBtn, tag).toBe(true);
    }
  });

  it('every JS-created button/chip carries a k- primitive and a variant', () => {
    const script = scriptBlock();
    const chipAssigns = [...script.matchAll(/class="k-chip[^"]*"/g)].map((m) => m[0]);
    expect(chipAssigns.length).toBeGreaterThan(0);
    const linkAssigns = [...script.matchAll(/class="k-btn k-btn--link[^"]*"/g)].map((m) => m[0]);
    expect(linkAssigns.length).toBeGreaterThan(0);
    const secondaryAssigns = [...script.matchAll(/class="k-btn k-btn--secondary[^"]*"/g)].map((m) => m[0]);
    expect(secondaryAssigns.length).toBeGreaterThan(0);
  });

  it('renders the sort control as a real, keyboard-reachable button inside the <th> — never a click handler on the <th> itself (UI-R09)', () => {
    const script = scriptBlock();
    // The motivating defect: `<th data-sort="total" class="sortable">`, a click
    // handler on a table-header cell with no role, no tabindex, no key handler.
    expect(script).not.toMatch(/<th[^>]*data-sort/);
    expect(script).toMatch(
      /<th\$\{cls\}\$\{sorted\}><button type="button" class="k-btn k-btn--link" data-sort="\$\{esc\(c\.sort\)\}">/,
    );
    // aria-sort stays on the <th>, matching STYLE-GUIDE.md's DO example.
    expect(script).toContain('aria-sort="descending"');
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

  it('gives the range chip aria-pressed instead of a bespoke bordered-button toggle (UI-R08)', () => {
    const script = scriptBlock();
    expect(script).toMatch(/class="k-chip" data-range="\$\{esc\(r\.id\)\}" aria-pressed="\$\{r\.id === state\.rangeId\}"/);
  });

  it('routes set-range, set-sort, set-page and open-dashboard through karstAction instead of firing on an un-acked click (UI-R11–R13)', () => {
    const script = scriptBlock();
    expect(script).toMatch(/karstAction\(btn,\s*\(requestId\)\s*=>\s*post\(\{\s*type:\s*'set-range',\s*range:\s*btn\.dataset\.range,\s*requestId\s*\}\)\)/);
    expect(script).toMatch(/karstAction\(btn,\s*\(requestId\)\s*=>\s*post\(\{\s*type:\s*'set-sort',\s*sort:\s*btn\.dataset\.sort,\s*requestId\s*\}\)\)/);
    expect(script).toMatch(/karstAction\(btn,\s*\(requestId\)\s*=>\s*post\(\{\s*type:\s*'set-page',\s*offset:\s*Number\(btn\.dataset\.page\),\s*requestId\s*\}\)\)/);
    expect(script).toMatch(/karstAction\(btn,\s*\(requestId\)\s*=>\s*post\(\{\s*type:\s*'open-dashboard',\s*ticketId:\s*Number\(btn\.dataset\.ticket\),\s*requestId\s*\}\)\)/);
    // No delegated, un-acked click listener left over from before.
    expect(script).not.toContain("document.addEventListener('click'");
  });

  it('handles action-result by settling the pending control (UI-R13)', () => {
    const script = scriptBlock();
    expect(script).toContain("msg.type === 'action-result'");
    expect(script).toContain('karstSettle(msg.requestId, msg.ok, msg.message)');
  });

  it('the pager keeps a statically disabled Previous/Next free of aria-busy, and names why it is disabled (UI-R17, R19)', () => {
    const script = scriptBlock();
    // The disabled attribute is conditional on page bounds; aria-busy is
    // never written into this template at all — it can only be added later,
    // at runtime, by karstAction's own pending lifecycle on a non-disabled click.
    const pagerTemplate = script.slice(script.indexOf('const prevTitle'), script.indexOf("for (const btn of pager"));
    expect(pagerTemplate).not.toContain('aria-busy');
    expect(pagerTemplate).toContain("p.hasPrev ? '' : ' disabled'");
    expect(pagerTemplate).toContain("p.hasNext ? '' : ' disabled'");
    expect(pagerTemplate).toContain('No earlier page');
    expect(pagerTemplate).toContain('No further page');
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

  it('shows the empty state instead of a grid of zeroes, using the shared .k-empty primitive', () => {
    expect(HTML).toContain('class="k-empty hidden" id="empty"');
    expect(HTML).toContain('class="k-empty-title"');
    expect(HTML).toContain('class="k-empty-hint" id="emptyHint"');
    expect(HTML).toContain('No AI token usage recorded yet');
    expect(HTML).toContain('state.empty');
  });

  it('never shows the empty state for a REJECTED query — that is a different claim', () => {
    expect(HTML).toContain('state.empty && !state.error');
    expect(HTML).toContain('id="err"');
  });

  it('announces a rejected query through the one shared toast live region, not a second live region on #err (UI-R27)', () => {
    const script = scriptBlock();
    expect(script).toContain("karstToast('error', state.error)");
    // Exactly one role="status" in the whole document — the toast root the
    // injected runtime creates. #err itself carries no role/aria-live.
    expect(HTML).not.toMatch(/id="err"[^>]*role=/);
    expect(HTML).not.toMatch(/id="err"[^>]*aria-live=/);
  });

  it('escapes every interpolated value it renders', () => {
    expect(HTML).toContain('const esc =');
    // Labels and ticket titles are user/board-authored text reaching innerHTML.
    expect(HTML).toContain('esc(r.label)');
    expect(HTML).toContain('esc(t.label)');
  });

  it('gives the ticket-open link a matching aria-label alongside its title (UI-R07, R24)', () => {
    const script = scriptBlock();
    expect(script).toMatch(/title="\$\{esc\(t\.label\)\}" aria-label="\$\{esc\(t\.label\)\}"/);
  });

  it('posts only the five narrowed message types', () => {
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

  it('names the breakdown by what it actually groups — call sites, not workflow stages', () => {
    // The panel read "By stage" while every row was an AI call site, so a reader
    // looked for `impl` in a list that can never contain one and concluded the
    // numbers were wrong. The word must not come back.
    expect(HTML).toContain('By call site');
    expect(HTML).not.toMatch(/By stage/);
    expect(HTML).not.toMatch(/\bbyStage\b/);
  });

  it('says out loud that only karst’s own AI calls are metered', () => {
    // Without this the absence of the agent session reads as a missing number
    // rather than as something never measured.
    expect(HTML).toContain('id="callSiteNote"');
    expect(HTML).toMatch(/interactive agent session/i);
  });

  it('leads with the effective total and keeps the raw one beside it', () => {
    expect(HTML).toContain('effectiveDisplay');
    expect(HTML).toContain('effectiveExact');
    // Both tiles: the weighting is only checkable against the raw measurement.
    expect(HTML).toContain("statCard('Effective'");
    expect(HTML).toContain("statCard('Total tokens'");
  });

  it('scrolls the wide table inside its own frame, not the page', () => {
    expect(HTML).toContain('class="tscroll"');
    expect(HTML).toMatch(/\.tscroll\{overflow-x:auto\}/);
  });
});
