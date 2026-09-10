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

  it('the pager keeps a statically disabled Previous/Next free of aria-busy, and names why it is disabled (UI-R17, R19)', () => {
    const script = scriptBlock();
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
    expect(HTML).not.toMatch(/toLocaleString\(\s*['"]en-US/);
    expect(HTML).not.toMatch(/\/\s*1000\b/);
    expect(HTML).not.toContain("'k'");
  });

  it('takes bar widths from the host-computed share', () => {
    expect(HTML).toContain('width:${Number(r.share) || 0}%');
    expect(HTML).not.toMatch(/\/\s*(?:total|state\.totals)/);
  });

  it('announces a rejected query through the one shared toast live region, not a second live region on #err (UI-R27)', () => {
    const script = scriptBlock();
    expect(script).toContain("karstToast('error', state.error)");
    expect(HTML).not.toMatch(/id="err"[^>]*role=/);
    expect(HTML).not.toMatch(/id="err"[^>]*aria-live=/);
  });

  it('scrolls the wide table inside its own frame, not the page', () => {
    expect(HTML).toContain('class="tscroll"');
    expect(HTML).toMatch(/\.tscroll\{overflow-x:auto\}/);
  });

  it('renders the profile label and the host-resolved provider note, escaped', () => {
    const script = scriptBlock();
    expect(script).toContain("(r.note ? ` · ${esc(r.note)}` : '')");
    expect(script).not.toContain('unknown profile');
  });

  it('gives the graph-profile panel its own categorical series bar (UI-R06)', () => {
    const style = styleBlock();
    expect(style).toMatch(/\.panel\.profiles \.bar > i\{background:var\(--k-series-2\)\}/);
  });
});
