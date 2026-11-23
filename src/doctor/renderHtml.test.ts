import { describe, expect, it } from 'vitest';
import { cspMetaTag } from '../model/csp.js';
import { DS_CSS_MARKER, injectDesignSystem } from '../model/designSystem.js';
import { injectPalette, PALETTE_MARKER } from '../model/palette.js';
import { doctorErrorHtml, doctorLoadingHtml, renderDoctorHtml } from './renderHtml.js';
import { DOCTOR_FIXTURES } from './renderFixtures.js';
import type { DoctorCheck, DoctorReport } from './types.js';

const report = (patch: Partial<DoctorReport>): DoctorReport => ({
  areas: ['tools', 'manifest', 'state', 'wiring'],
  fixRequested: false,
  checks: [],
  applied: [],
  summary: { ok: 0, warn: 0, fail: 0, skipped: 0 },
  exitCode: 0,
  ...patch,
});

const check = (patch: Partial<DoctorCheck> & Pick<DoctorCheck, 'id' | 'area' | 'status'>): DoctorCheck => ({
  detail: 'Detail text.',
  ...patch,
});

const PAGES: ReadonlyArray<[string, (nonce: string) => string]> = [
  ['report', (n) => renderDoctorHtml(report({ checks: [check({ id: 'tools.git', area: 'tools', status: 'ok', title: 'Git' })] , summary: { ok: 1, warn: 0, fail: 0, skipped: 0 } }), n)],
  ['loading', (n) => doctorLoadingHtml(n)],
  ['error', (n) => doctorErrorHtml('boom', n)],
];

describe('the shared document shell', () => {
  it.each(PAGES)('is a lang="en" document with the shared CSP meta and a nonce script (%s)', (_name, page) => {
    const html = page('abc123');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(html).toContain(cspMetaTag('abc123'));
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('<title>Karst Doctor</title>');
  });

  it.each(PAGES)('carries both design-system markers and keeps the palette as the last style block (%s)', (_name, page) => {
    const html = page('n');
    expect(html).toContain(DS_CSS_MARKER);
    expect(html).toContain(PALETTE_MARKER);
    const lastOpen = html.lastIndexOf('<style>');
    const paletteAt = html.lastIndexOf(PALETTE_MARKER);
    expect(lastOpen).toBeGreaterThan(0);
    expect(paletteAt).toBeGreaterThan(lastOpen);
    // Nothing but the palette marker between the last <style> and </style>.
    expect(html.slice(lastOpen + '<style>'.length, paletteAt).trim()).toBe('');
  });

  it.each(PAGES)('hydrates tokens, primitives and palette without leaving a marker (%s)', (_name, page) => {
    const html = injectPalette(injectDesignSystem(page('n')));
    expect(html).toContain('--k-space-4:8px;');
    expect(html).toContain('.k-pagehead{');
    expect(html).toContain('.k-status{');
    expect(html).toContain('.k-btn{');
    expect(html).toContain('--k-passed:');
    expect(html).not.toContain(DS_CSS_MARKER);
    expect(html).not.toContain(PALETTE_MARKER);
  });

  it.each(PAGES)('uses <main> and one shared page header with no brand mark (%s)', (_name, page) => {
    const html = page('n');
    expect(html).toContain('<main>');
    expect(html).toContain('<header class="k-pagehead">');
    expect(html).toContain('<div class="k-pagehead-main">');
    expect(html).toContain('<h1 class="k-pagehead-title" tabindex="-1">Karst Doctor</h1>');
    expect(html).not.toContain('k-pagehead-mark');
    expect(html.match(/<h1 class="k-pagehead-title"/gu)).toHaveLength(1);
  });

  it('never carries a local .k-status rule (UI-R28b)', () => {
    const html = renderDoctorHtml(DOCTOR_FIXTURES.warnings, 'n');
    expect(html).not.toMatch(/\.k-status(\s|--|:|\{|,)/u);
  });

  it('never hard-codes a colour literal in the page CSS', () => {
    const html = renderDoctorHtml(DOCTOR_FIXTURES.warnings, 'n');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(head).not.toMatch(/\b(?:rgba?|hsla?)\(/u);
  });
});

describe('status glyphs (UI-R28b)', () => {
  const html = renderDoctorHtml(
    report({
      checks: [
        check({ id: 'tools.ok', area: 'tools', status: 'ok', title: 'Git' }),
        check({ id: 'tools.warn', area: 'tools', status: 'warn', title: 'Npm' }),
        check({ id: 'state.fail', area: 'state', status: 'fail', title: 'Schema' }),
        check({ id: 'state.skip', area: 'state', status: 'skipped', title: 'Prune' }),
      ],
      summary: { ok: 1, warn: 1, fail: 1, skipped: 1 },
      exitCode: 1,
    }),
    'n',
  );

  it.each([
    ['passed', '✓', 'Passed'],
    ['attention', '⏸', 'Warning'],
    ['failed', '✕', 'Failed'],
    ['pending', '○', 'Not checked'],
  ])('renders %s as a %s glyph named %s', (kind, glyph, label) => {
    expect(html).toContain(`<span class="k-status k-status--${kind}" role="img" aria-label="${label}">${glyph}</span>`);
  });

  it('renders no visible status word inside the primitive', () => {
    expect(html).not.toMatch(/class="k-status[^"]*"[^>]*>(?:Passed|Warning|Failed|Not checked)</u);
  });
});

describe('ordering, grouping and the header subtitle (DR-6, DR-8, DR-9)', () => {
  const html = renderDoctorHtml(
    report({
      checks: [
        check({ id: 'tools.old', area: 'tools', status: 'ok', title: 'Git', detail: 'OK-ROW' }),
        check({ id: 'manifest.w', area: 'manifest', status: 'warn', title: 'Repos', detail: 'WARN-ROW' }),
        check({ id: 'state.f', area: 'state', status: 'fail', title: 'Schema', detail: 'FAIL-ROW' }),
        check({ id: 'state.w', area: 'state', status: 'warn', title: 'WAL', detail: 'SECOND-WARN-ROW' }),
        check({ id: 'tools.s', area: 'tools', status: 'skipped', title: 'Probe', detail: 'SKIP-ROW' }),
      ],
      summary: { ok: 1, warn: 2, fail: 1, skipped: 1 },
      exitCode: 1,
    }),
    'n',
    { checkedAt: new Date(2026, 0, 1, 14, 2) },
  );

  it('puts the failing area before the warning area before the passed details', () => {
    expect(html.indexOf('data-area="state"')).toBeLessThan(html.indexOf('data-area="manifest"'));
    expect(html.indexOf('data-area="manifest"')).toBeLessThan(html.indexOf('<details class="doc-passed">'));
  });

  it('sorts rows inside one area worst-first', () => {
    const stateAt = html.indexOf('data-area="state"');
    const manifestAt = html.indexOf('data-area="manifest"');
    const state = html.slice(stateAt, manifestAt);
    expect(state.indexOf('FAIL-ROW')).toBeLessThan(state.indexOf('SECOND-WARN-ROW'));
  });

  it('labels every area section with an h2 in DOCTOR_AREAS wording', () => {
    for (const label of ['Tools', 'Manifest', 'State']) expect(html).toContain(`<h2>${label}</h2>`);
  });

  it('folds passes into a plural summary with an area heading', () => {
    expect(html).toContain('<details class="doc-passed">');
    expect(html).toContain('<summary>1 check passed</summary>');
    const details = html.slice(html.indexOf('<details class="doc-passed">'));
    expect(details).toContain('<h2>Tools</h2>');
  });

  it('summarises the run in .k-pagehead-sub with plural() and the clock time', () => {
    const sub = html.slice(html.indexOf('class="k-pagehead-sub"'), html.indexOf('</p>', html.indexOf('class="k-pagehead-sub"')));
    expect(sub).toContain('1 failed');
    expect(sub).toContain('2 warnings');
    expect(sub).toContain('1 passed');
    expect(sub).toContain('1 not checked');
    expect(sub).toContain('Checked at 14:02');
  });

  it('accepts a preformatted time string', () => {
    const only = renderDoctorHtml(report({ checks: [], summary: { ok: 0, warn: 0, fail: 0, skipped: 0 } }), 'n', { checkedAt: '09:05' });
    expect(only).toContain('Checked at 09:05');
  });

  it('says All N checks passed when nothing needs attention', () => {
    const clean = renderDoctorHtml(DOCTOR_FIXTURES['all-ok'], 'n', { checkedAt: '09:05' });
    expect(clean).toContain('All 6 checks passed');
    expect(clean).toContain('Checked at 09:05');
  });

  it('derives a human title when a check has none', () => {
    const titled = renderDoctorHtml(
      report({ checks: [check({ id: 'state.server-dead.12', area: 'state', status: 'warn', title: undefined })], summary: { ok: 0, warn: 1, fail: 0, skipped: 0 } }),
      'n',
    );
    expect(titled).toContain('<span class="doc-title">Server dead 12</span>');
  });
});

describe('fix text (DR-2)', () => {
  const html = renderDoctorHtml(DOCTOR_FIXTURES.warnings, 'n');

  it('never prints a fix tier name', () => {
    expect(html).not.toContain('consented:');
    expect(html).not.toContain('report:');
    expect(html).not.toContain('auto:');
  });

  it('renders a consented fix as a copyable command, not prose in <code>', () => {
    expect(html).toContain('<pre class="k-code">sbx prune --all</pre>');
    expect(html).toContain('data-copy="sbx prune --all"');
    expect(html).toContain('>Copy</button>');
  });

  it('renders a report fix as plain text with no <code> tag in the fix block', () => {
    const at = html.indexOf('Fix: Upgrade npm');
    const end = html.indexOf('</li>', at);
    const block = html.slice(at, end);
    expect(block).toContain('<p class="doc-fix-step">Upgrade npm to 10.8.0 or newer, then reload the window.</p>');
    expect(block).not.toContain('<code');
  });

  it('renders an auto fix as Fixed by Fix safe issues', () => {
    const auto = renderDoctorHtml(DOCTOR_FIXTURES['auto-fixes'], 'n');
    expect(auto).toContain('<p class="doc-fix-step">Fixed by Fix safe issues</p>');
  });

  it('starts each fix block with Fix: and the real summary', () => {
    expect(html).toContain('Fix: Upgrade npm');
    expect(html).toContain('Fix: Prune the sandbox images');
  });
});

describe('the fix action and its busy state (DR-5)', () => {
  const html = renderDoctorHtml(DOCTOR_FIXTURES['auto-fixes'], 'n');

  it('counts only non-ok auto fixes and labels the button', () => {
    expect(html).toContain('id="fix"');
    expect(html).toContain('>Fix safe issues (3)</button>');
    expect(html).toContain('data-label="Fix safe issues (3)"');
  });

  it('posts rerun from Run again and fix from the primary action', () => {
    expect(html).toContain('id="rerun"');
    expect(html).toContain("v.postMessage({ type: 'rerun' })");
    expect(html).toContain("v.postMessage({ type: 'fix' })");
  });

  it('disables the button, sets aria-busy and shows Fixing…', () => {
    expect(html).toContain('fix.disabled = true');
    expect(html).toContain("fix.setAttribute('aria-busy', 'true')");
    expect(html).toContain("fix.textContent = 'Fixing…'");
  });

  it('restores the button from data-label on fix-cancelled and refocuses it', () => {
    expect(html).toContain("e.data.type === 'fix-cancelled'");
    expect(html).toContain('fix.dataset.label');
    expect(html).toContain('fix.focus()');
  });

  it('forwards Copy clicks as a copy message', () => {
    const warnings = renderDoctorHtml(DOCTOR_FIXTURES.warnings, 'n');
    expect(warnings).toContain("v.postMessage({ type: 'copy', text:");
    expect(warnings).toContain('.doc-copy');
  });

  it('focuses the page title after a fix run and when asked', () => {
    const afterFix = renderDoctorHtml({ ...DOCTOR_FIXTURES.applied, fixRequested: true }, 'n');
    expect(afterFix).toContain("document.querySelector('.k-pagehead-title')?.focus()");
    const asked = renderDoctorHtml(DOCTOR_FIXTURES['all-ok'], 'n', { focusTitle: true });
    expect(asked).toContain("document.querySelector('.k-pagehead-title')?.focus()");
    const plain = renderDoctorHtml(DOCTOR_FIXTURES['all-ok'], 'n');
    expect(plain).not.toContain("document.querySelector('.k-pagehead-title')?.focus()");
  });
});

describe('applied fixes', () => {
  const html = renderDoctorHtml(DOCTOR_FIXTURES.applied, 'n');

  it('lists every applied fix with its outcome word and evidence', () => {
    expect(html).toContain('Applied fixes');
    expect(html).toContain('Fixed: killed pid 4123');
    expect(html).toContain('Skipped: skipped prune of /tmp/wt/api');
    expect(html).toContain('<code class="doc-id">pid 4123 started 2026-01-01T09:59:00Z, recorded 2026-01-01T10:00:00Z</code>');
  });
});

describe('responsive page CSS (UI-R43, @ui:RD-TIERS)', () => {
  const html = renderDoctorHtml(DOCTOR_FIXTURES.warnings, 'n');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  it('stacks the row head at the 699 px tier and the command row at 399 px', () => {
    expect(css).toContain('@media (max-width: 699px)');
    expect(css).toContain('@media (max-width: 399px)');
    expect(css).toContain('.doc-row-head{flex-direction:column;align-items:flex-start');
  });

  it('wraps the command without horizontal scroll', () => {
    expect(css).toContain('white-space:pre-wrap');
    expect(css).toContain('overflow-wrap:anywhere');
    expect(css).toContain('min-width:0');
  });

  it('shows a visible focus ring on the title and summaries', () => {
    expect(css).toContain('.k-pagehead-title:focus-visible');
    expect(css).toContain('summary:focus-visible');
    expect(css).toContain('var(--k-focus)');
  });
});

describe('loading and error pages (DR-4)', () => {
  it('shows a status spinner while the checks run', () => {
    const html = doctorLoadingHtml('n');
    expect(html).toContain('<div class="doc-state" role="status">');
    expect(html).toContain('k-spinner');
    expect(html).toContain('Running checks…');
  });

  it('escapes the reason and offers Run again on failure', () => {
    const html = doctorErrorHtml('<bad & "quoted">', 'n');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Karst could not run the checks: &lt;bad &amp; &quot;quoted&quot;&gt;.');
    expect(html).toContain('id="rerun"');
    expect(html).toContain('>Run again</button>');
    expect(html).toContain("v.postMessage({ type: 'rerun' })");
  });
});

describe('escapes every dynamic string', () => {
  it('escapes detail, title, id and summaries', () => {
    const html = renderDoctorHtml(
      report({
        checks: [
          check({
            id: 'tools.<id>',
            area: 'tools',
            status: 'warn',
            title: '<script>alert(1)</script>',
            detail: '<b>hi</b>',
            fix: { tier: 'report', summary: '<i>s</i>', nextStep: '<u>n</u>' },
          }),
        ],
        summary: { ok: 0, warn: 1, fail: 0, skipped: 0 },
      }),
      'n',
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<b>hi</b>');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Fix: &lt;i&gt;s&lt;/i&gt;');
    expect(html).toContain('&lt;u&gt;n&lt;/u&gt;');
    expect(html).toContain('tools.&lt;id&gt;');
  });
});

describe('every fixture renders', () => {
  it.each(Object.keys(DOCTOR_FIXTURES))('renders the %s fixture and hydrates it fully', (name) => {
    const html = renderDoctorHtml(DOCTOR_FIXTURES[name as keyof typeof DOCTOR_FIXTURES], 'n');
    expect(html).toContain('class="k-pagehead"');
    const hydrated = injectPalette(injectDesignSystem(html));
    expect(hydrated).not.toContain(DS_CSS_MARKER);
    expect(hydrated).not.toContain(PALETTE_MARKER);
  });

  it('shows Not checked for a skipped check (DR-10)', () => {
    const html = renderDoctorHtml(DOCTOR_FIXTURES.skipped, 'n');
    expect(html).toContain('aria-label="Not checked"');
    expect(html).toContain('not checked');
  });
});
