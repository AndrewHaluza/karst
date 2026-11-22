import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USAGE_SORTS } from '../../store/tokenUsageQuery.js';

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
  it("persists the selected tab with vscode.setState on each 'state' message, guarded by try/catch", () => {
    const script = scriptBlock();
    const branch = script.slice(script.indexOf("msg.type === 'state'"));
    expect(branch).toMatch(/try\s*\{[^}]*vscode\.setState\(\{\s*tab:\s*msg\.state\.tab\s*\}\)[^}]*\}\s*catch/);
  });

  it('keeps the CSP marker — without it the page ships with no policy', () => {
    expect(HTML).toContain('<!--KARST_CSP-->');
  });

  it('carries the design-system and agent markers ahead of any file-local rule (UI-R03)', () => {
    const style = styleBlock();
    expect(style.trimStart().startsWith('/*KARST_DS_CSS*/')).toBe(true);
    expect(style).toContain('/*KARST_AGENT_CSS*/');
    const script = scriptBlock();
    expect(script.trimStart().startsWith('/*KARST_DS_JS*/')).toBe(true);
    expect(script).toContain('/*KARST_AGENT_JS*/');
  });

  it('carries the palette marker so quota fills resolve their semantic colors', () => {
    expect(HTML).toContain('/*KARST_PALETTE*/');
  });

  it('declares no local :root block — tokens come from the injected design system (UI-R04, R05)', () => {
    const style = styleBlock();
    expect(style).not.toContain(':root');
  });

  it('contains no raw hex/rgb/px/rem style literal outside the injected tokens and the two tier edges (UI-R04)', () => {
    const style = styleBlock();
    const local = style.slice(style.indexOf('/*KARST_DS_CSS*/') + '/*KARST_DS_CSS*/'.length);
    // @ui:RD-TIERS: a container condition cannot read a custom property, so the
    // two canonical edges (699px narrow, 399px tight) are the only literal form.
    const withoutComments = local.replace(/\/\*.*?\*\//gs, '');
    const withoutTiers = withoutComments.replace(/\(max-width:\s*(?:699|399)px\)/g, '(max-width:TIER)');
    const offenders = withoutTiers.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b[0-9]+(\.[0-9]+)?(px|rem)\b/g);
    expect(offenders, JSON.stringify(offenders)).toBeNull();
    expect(withoutComments.match(/@container\s*\(max-width:\s*(?:699|399)px\)/g)).toHaveLength(2);
  });

  it('does not restyle a bare <button> element — every control is a k- primitive', () => {
    const style = styleBlock();
    expect(style).not.toMatch(/(^|\s|\})button\s*\{/);
    expect(style).not.toMatch(/(^|\s|\})button:hover\s*\{/);
    expect(style).not.toMatch(/(^|\s|\})button:focus-visible\s*\{/);
  });

  it('renders the shared page header primitive with one title and the scope subtitle (US-33)', () => {
    expect(HTML).toContain('<header class="k-pagehead">');
    expect(HTML.match(/<h1 class="k-pagehead-title">/g)).toHaveLength(1);
    expect(HTML).toContain('class="k-pagehead-sub" id="sub"');
    expect(HTML).toContain('class="k-pagehead-actions"');
    expect(HTML).not.toContain('class="k-pagehead-mark"');
  });

  it('builds real tabs with tab semantics and a roving tabindex (US-21)', () => {
    const script = scriptBlock();
    expect(HTML).toContain('role="tablist"');
    expect(script).toContain('role="tab"');
    expect(script).toContain('aria-selected=');
    expect(script).toContain('aria-controls=');
    expect(script).toContain('tabindex=');
    expect(script).toContain("'ArrowRight'");
    expect(script).toContain("'Home'");
    expect(script).toContain("'End'");
    expect(script).toContain('class="k-tab"');
    expect(script).not.toContain('aria-pressed=');
  });

  it('restores keyboard focus to the matching control after a re-render (US-24)', () => {
    const script = scriptBlock();
    expect(script).toContain('captureFocus');
    expect(script).toContain('restoreFocus');
    expect(script).toContain('data-dir="prev"');
    expect(script).toContain('data-dir="next"');
  });

  it('the pager keeps a statically disabled Previous/Next free of aria-busy, and names why it is disabled (UI-R17, R19)', () => {
    const script = scriptBlock();
    const pagerTemplate = script.slice(script.indexOf('const prevTitle'), script.indexOf("for (const btn of pager"));
    expect(pagerTemplate).not.toContain('aria-busy');
    expect(pagerTemplate).toContain("p.hasPrev ? '' : ' disabled'");
    expect(pagerTemplate).toContain("p.hasNext ? '' : ' disabled'");
    expect(pagerTemplate).toContain('No earlier page');
    expect(pagerTemplate).toContain('No further page');
    // Both offsets reach innerHTML only through esc(): an unescaped interpolation is a CodeQL XSS sink (js/xss).
    expect(pagerTemplate).toContain('data-page="${esc(prevOffset)}"');
    expect(pagerTemplate).toContain('data-page="${esc(nextOffset)}"');
  });

  it('renders the host-built callsText and page summary, with no local plural code', () => {
    const script = scriptBlock();
    expect(script).toContain('r.callsText');
    expect(script).toContain('p.summary');
    expect(script).not.toContain('=== 1 ?');
  });

  it('renders pre-formatted counts and never formats a number itself', () => {
    expect(HTML).toContain('totalDisplay');
    expect(HTML).toContain('inputDisplay');
    expect(HTML).not.toMatch(/toLocaleString\(\s*['"]en-US/);
    expect(HTML).not.toMatch(/\/\s*1000\b/);
    expect(HTML).not.toContain("'k'");
  });

  it('takes bar widths and share text from the host (US-18)', () => {
    expect(HTML).toContain('width:${Number(r.share) || 0}%');
    expect(HTML).toContain('r.shareDisplay');
    expect(HTML).not.toMatch(/\/\s*(?:total|state\.totals)/);
  });

  it('formats dates on the host and renders a <time> element (US-16, UI-R31)', () => {
    const script = scriptBlock();
    expect(script).not.toContain('localDate');
    expect(script).toContain('<time datetime=');
    expect(script).toContain('t.lastTitle');
    expect(HTML).toContain('t.lastDisplay');
  });

  it('keeps the ticket key in its own non-shrinking span (US-35)', () => {
    expect(HTML).toContain('class="tkt-key"');
    expect(HTML).toContain('class="tkt-title"');
    const style = styleBlock();
    expect(style).toMatch(/\.tkt-key\{white-space:nowrap;flex:none/);
    expect(style).toMatch(/\.tkt-title\{min-width:0;overflow:hidden;text-overflow:ellipsis/);
    // UI-R19: an ellipsised text must expose its full value to AT; the button's title alone does not count.
    expect(scriptBlock()).toContain('<span class="tkt-title" aria-label=');
    // The cell contributes no min-content width, so a long title ellipsises inside the free column instead of
    // widening the table past the page edge (the 1280 layout run catches the overflow, US-35/US-R43).
    expect(style).toMatch(/td\.tkt\{white-space:normal;max-width:0\}/);
    expect(style).toMatch(/td\.tkt\{grid-column:1 \/ -1;max-width:none\}/);
  });

  it('renders a sortable header through the shared .k-sort control with its arrow hidden from AT (US-25)', () => {
    const script = scriptBlock();
    expect(script).toContain('class="k-sort"');
    expect(script).toContain('aria-hidden="true">↓');
    expect(script).toContain("', sorted descending'");
    expect(styleBlock()).not.toContain('th[aria-sort]::after');
  });

  it('never scrolls the table sideways — the tiers reflow it instead (US-8, UI-R43)', () => {
    expect(HTML).not.toContain('tscroll');
    expect(styleBlock()).not.toContain('overflow-x:auto');
    const script = scriptBlock();
    expect(script).toContain('data-priority=');
    expect(script).toContain('data-label=');
    expect(styleBlock()).toContain('[data-priority="3"]{display:none}');
    expect(styleBlock()).toContain('td::before{content:attr(data-label)');
    expect(script).toContain('role="row"');
    expect(script).toContain('role="cell"');
  });

  it('announces an action’s failure through the one shared toast live region, not a second region on #err (UI-R27, US-14)', () => {
    const script = scriptBlock();
    expect(script).toContain("if (userActionPending) karstToast('error', state.error)");
    expect(HTML).not.toMatch(/id="err"[^>]*role=/);
    expect(HTML).not.toMatch(/id="err"[^>]*aria-live=/);
    expect(script).toContain("el('errText').textContent = state.error || ''");
    expect(HTML).toContain('id="retryBtn"');
  });

  it('still offers one way out of an error (US-2)', () => {
    const script = scriptBlock();
    expect(script).toContain("post({ type: 'request-state', requestId })");
    expect(HTML).toContain('Try again');
  });

  it('renders the loading skeleton, hides it on the first state and keeps one status node (US-12)', () => {
    expect(HTML).toContain('id="loading"');
    // The frames must read as placeholders in every theme: the sunken fill equals the page background.
    expect(styleBlock()).toContain('.sk{background:var(--k-surface);border:var(--k-border-w) solid var(--k-border)');
    expect(HTML).toContain('role="status"');
    expect(HTML).toContain('Loading token usage');
    const script = scriptBlock();
    expect(script).toContain("el('loading').classList.add('hidden')");
    expect(script).toContain("el('status').textContent = state.updatedLabel");
  });

  it('renders the empty Spend state with a way forward (US-15)', () => {
    expect(HTML).toContain('No token usage yet');
    expect(HTML).toContain('id="createTicketBtn"');
    expect(scriptBlock()).toContain("type: 'create-ticket'");
  });

  it('renders quota meta and the expired sentence from the host, never a local countdown (US-3)', () => {
    const script = scriptBlock();
    expect(script).toContain('esc(w.meta)');
    expect(script).not.toContain('resets in ');
    expect(script).toContain('w.expired ? 0 : w.usedPct');
    expect(script).not.toContain('w.usedPct}%');
    expect(script).toContain('esc(w.usedDisplay)');
  });

  it('gives each quota window a meter role and the status a word, not colour alone (US-19, US-26)', () => {
    const script = scriptBlock();
    expect(script).toContain('role="meter"');
    expect(script).toContain('aria-valuemin="0"');
    expect(script).toContain('aria-valuemax="100"');
    expect(script).toContain('esc(w.ariaLabel)');
    expect(script).toContain('esc(w.levelLabel)');
    expect(script).toContain("icon('circle-x')");
    expect(script).toContain("icon('alert-triangle')");
  });

  it('offers the empty Quota state and its settings action (US-13)', () => {
    expect(HTML).toContain('No quota read yet');
    expect(HTML).toContain('id="quotaSettingsBtn"');
    expect(scriptBlock()).toContain("type: 'open-quota-settings'");
    expect(HTML).toContain('Refresh quota');
    expect(scriptBlock()).toContain("type: 'refresh-quota'");
  });

  it('renders a stale read as possibly out of date with a glyph and the attention colour (US-31)', () => {
    const script = scriptBlock();
    expect(script).toContain('r.readMeta');
    expect(script).toContain('r.stale');
    expect(scriptBlock()).toContain("r.stale ? icon('alert-triangle')");
    expect(styleBlock()).toContain('.qrow .qmeta .stale{color:var(--k-attention-fg)');
  });

  it('uses tabular numerals for every numeric column and figure (UI-R41)', () => {
    const style = styleBlock();
    expect(style).toMatch(/\.stat \.v\{[^}]*font-variant-numeric:tabular-nums/);
    expect(style).toMatch(/\.brow \.amt\{[^}]*font-variant-numeric:tabular-nums/);
    expect(style).toMatch(/th\.num,td\.num\{[^}]*font-variant-numeric:tabular-nums/);
  });

  it('prints the canonical core mark for a known provider row (@ui:SG-25)', () => {
    const script = scriptBlock();
    expect(script).toContain('agentBadgeHtml(r.key)');
    expect(script).toContain("r.key !== '__other__'");
  });

  it('renders the profile label and the host-resolved provider note, escaped', () => {
    const script = scriptBlock();
    expect(script).toContain("(r.note ? ` · ${esc(r.note)}` : '')");
    expect(script).not.toContain('unknown profile');
  });

  it('uses one categorical series for every breakdown bar (US-22)', () => {
    const style = styleBlock();
    expect(style).toContain('.bar > i{display:block;height:100%;background:var(--k-series-1)');
    expect(style).not.toContain('--k-series-2');
  });
});

const bodyRules = [...HTML.matchAll(/(?<![\w#.\-])body\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
const bodyHas = (...res: RegExp[]) => bodyRules.some((r) => res.every((re) => re.test(r)));

describe('content width cap (UI-R48)', () => {
  it('caps and centers body', () => {
    expect(bodyHas(/max-width\s*:\s*var\(--k-content-max\)/, /margin-inline\s*:\s*auto/)).toBe(true);
  });
});

describe('sort vocabulary', () => {
  it('offers exactly the host’s sort ids in the table headers', () => {
    const script = scriptBlock();
    const columns = script.slice(script.indexOf('const COLUMNS'), script.indexOf('let lastState'));
    for (const sort of USAGE_SORTS) {
      expect(columns, `missing sort column ${sort}`).toContain(`'${sort}'`);
    }
  });
});
