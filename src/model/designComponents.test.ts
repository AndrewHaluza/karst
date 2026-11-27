import { describe, it, expect } from 'vitest';
import { componentsCss, PRIMITIVES, STATE_MATRIX } from './designComponents.js';

const CSS = componentsCss();

/** Every rule whose selector mentions `sel`, joined — enough for text assertions. */
const rulesFor = (sel: string): string =>
  (CSS.match(new RegExp(`[^{}]*\\${sel}[^{}]*\\{[^}]*\\}`, 'g')) ?? []).join('\n');

describe('design system components', () => {
  it('defines every primitive the design system documents', () => {
    for (const cls of PRIMITIVES) {
      expect(CSS, `${cls} has no rule`).toContain(cls);
    }
  });

  it('expresses the full state matrix for every interactive primitive (UI-R07)', () => {
    // The eight states are the contract. A primitive missing one is a control
    // the user cannot tell the state of — which is the whole ticket.
    for (const cls of ['.k-btn', '.k-iconbtn']) {
      const rules = rulesFor(cls);
      for (const state of STATE_MATRIX) {
        expect(rules, `${cls} is missing its ${state} state`).toContain(state);
      }
    }
  });

  it('uses only tokens — no raw colour, length, or duration (UI-R04)', () => {
    expect(CSS, 'a hex literal survived').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CSS, 'an rgb/hsl literal survived').not.toMatch(/\b(?:rgba?|hsla?)\(/);
    // A container query condition cannot hold a var(): the 400px tier step is the one allowed raw length (@ui:UI-R49).
    // The toast ladder (@ui:RD-LADDERS2) steps the viewport at the 699 and 399 tier edges, also literals.
    const withoutQueryConditions = CSS.replace(/@container \(max-width: 400px\)/g, '@container').replace(/@media \(max-width: (?:699|399)px\)/g, '@media');
    expect(withoutQueryConditions, 'a raw length survived').not.toMatch(/(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b/);
    expect(CSS, 'a raw duration survived').not.toMatch(/(?<![\w-])\d+(?:\.\d+)?(?:ms|s)\b/);
  });

  it('gives every focusable primitive the one focus ring (UI-R23)', () => {
    // sidebar and welcome had no :focus-visible rule at all; usage covered only
    // bare `button`. One ring, defined once, reaches all seven webviews.
    for (const cls of [
      '.k-btn',
      '.k-iconbtn',
      '.k-link',
      '.k-input',
      '.k-switch',
      '.k-chip',
      '.k-tab',
      '.k-sort',
    ]) {
      expect(rulesFor(cls), `${cls} has no focus ring`).toContain(':focus-visible');
    }
    expect(CSS).toContain('var(--k-focus)');
  });

  it('never removes an outline without replacing it', () => {
    for (const [, decl] of CSS.matchAll(/outline:\s*(none|0)\b/g)) {
      expect.fail(`outline:${decl} with no replacement ring`);
    }
  });

  it('never disables a control with pointer-events (UI-R17)', () => {
    // pointer-events:none suppresses the title that explains WHY a control is
    // disabled, which is the only thing making the disablement actionable.
    // The one exception is `.k-select-chev`: a decorative glyph over a select that must pass the click through.
    const withoutChevron = CSS.replace(/\.k-select-chev\{[^}]*\}/, '');
    expect(withoutChevron).not.toMatch(/pointer-events:\s*none/);
  });

  it('carries the pending spinner on aria-busy, not on a bespoke class (UI-R11)', () => {
    expect(CSS).toContain('[aria-busy="true"]');
    expect(CSS).toContain('k-spin');
    expect(CSS).toContain('@keyframes k-spin');
  });

  it('nulls every animation under reduced motion without losing the state (UI-R30)', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('animation:none');
    expect(reduced).toContain('transition:none');
    // Every animated primitive belongs to the list, so a new chip cannot keep
    // a hover transition under reduced motion (UI-R30).
    expect(reduced).toMatch(/\.k-ticket-ref[,\{]/);
  });

  it('draws the reference chip as the rail pill: stage border and wash, text tone, no status dot (@ui:11.21)', () => {
    const chip = rulesFor('.k-ticket-ref');
    expect(chip).toContain('border:var(--k-border-w) solid var(--c)');
    expect(chip).toContain('var(--k-chip-wash)');
    expect(chip).toContain('align-items:baseline');
    expect(CSS).not.toContain('k-ticket-ref-dot');
    // The word picks full/short from the host width: one span, no hidden duplicates (@ui:UI-R51).
    expect(CSS).toContain('.k-ticket-ref-word::before{content:"· " attr(data-full)}');
    expect(CSS).toContain('content:"· " attr(data-short)');
    expect(rulesFor('.k-ticket-ref.is-needs')).toContain('var(--k-attention-fg)');
  });

  it('keeps the chip link hit area at 24px through ::after', () => {
    expect(CSS).toContain('.k-ticket-ref a::after');
    expect(CSS).toContain('var(--k-chip-hit-bleed)');
  });

  it('gives the danger variant its own look so destructive never reads as benign (UI-R10b)', () => {
    // settings had NO danger styling: "Delete agent" rendered exactly like "Cancel".
    expect(CSS).toContain('.k-btn--danger');
    expect(CSS).toContain('.k-iconbtn--danger');
    expect(rulesFor('.k-btn--danger')).toContain('var(--k-danger)');
  });

  it('gives the ghost variant an actual rule (UI-R10)', () => {
    // the ticket form applied `.ghost` to #attachBtn and no stylesheet defined it, so
    // the "ghost" button silently rendered as a primary.
    expect(CSS).toContain('.k-btn--ghost');
    expect(rulesFor('.k-btn--ghost').length).toBeGreaterThan(0);
  });

  it('gives a row no success or spinner treatment (UI-R13)', () => {
    const row = (CSS.match(/^\.k-btn--row[^{}]*\{[^}]*\}/gm) ?? []).join('\n');
    expect(row).not.toContain('.is-success');
    expect(CSS).toContain('.k-btn.is-success:not(.k-btn--row)');
    expect(CSS).toContain('.k-btn.is-spinning::before{');
  });

  it('draws the spinner only from .is-spinning, never from aria-busy (400ms show-delay)', () => {
    expect(CSS).not.toMatch(/\[aria-busy="true"\]::(before|after)/);
    expect(CSS).toContain('.k-btn--slot:not(.k-btn--row)::before');
  });

  it('keeps .is-success a tier-3 check: no colour or border change', () => {
    const rules = CSS.match(/[^{}]*\.is-success[^{}]*\{[^}]*\}/g) ?? [];
    for (const r of rules) {
      expect(r).not.toContain('var(--k-success)');
      expect(r).not.toMatch(/border-color|color:var/);
    }
  });

  it('applies every variant hover only to an enabled button (a disabled one looks the same on hover)', () => {
    const hovers = (CSS.match(/\.k-btn--[a-z]+:hover[^{]*\{/g) ?? []).map((h) => h.slice(0, -1));
    expect(hovers.length).toBeGreaterThanOrEqual(5);
    for (const sel of hovers) {
      // `:where()` keeps the guard at zero specificity, so a surface override such as `.rowopen:hover` still wins.
      expect(sel, sel).toContain(':where(:not(:disabled):not([aria-disabled="true"]))');
    }
  });

  it('keeps a row from shifting on click (UI-R12)', () => {
    const row = (CSS.match(/^\.k-btn--row[^{}]*\{[^}]*\}/gm) ?? []).join('\n');
    // A row is a full-width list item; the compact-button scale effect shifts
    // the whole row on mousedown. `:not(:disabled)` must survive so the rule
    // still wins the specificity tie with the generic `.k-btn:active`.
    expect(row, 'the row still scales on :active').toContain('.k-btn--row:active:not(:disabled){transform:none}');
  });

  it('gives every row the generic ::before pending spinner (UI-R11)', () => {
    // The diffs view's file rows are `.k-btn--row` and their ONLY pending
    // indicator is the generic `::before` spinner (re-positioned locally into
    // the rail cell). A busy-suppression must live in the sidebar's own CSS,
    // scoped to `.rowopen` — never here on `.k-btn--row`, or the diffs view
    // would show a busy row with no spinner and a hidden status letter.
    const busy = rulesFor('.k-btn');
    expect(busy, 'the generic spinner rule is gone').toContain('.k-btn.is-spinning::before{');
    expect(CSS, 'the DS suppresses the row spinner').not.toContain('.k-btn--row[aria-busy="true"]::before{content:none}');
  });

  it('keeps every pointer target at or above the WCAG minimum (UI-R29)', () => {
    const icon = rulesFor('.k-iconbtn');
    expect(icon).toContain('var(--k-hit-min)');
  });

  it('pairs foreground with background on every filled surface (UI-R29)', () => {
    // `background:#8957e5;color:#fff` is the defect: a foreground hand-picked
    // against a themed background. Filled variants must use the paired tokens.
    expect(rulesFor('.k-btn--primary')).toContain('var(--k-action-fg)');
    expect(rulesFor('.k-toast--error')).toContain('var(--k-danger)');
  });

  it('marks the toast container as the polite live region (UI-R27)', () => {
    expect(CSS).toContain('.k-toast-root');
    expect(rulesFor('.k-toast-root')).toContain('var(--k-z-toast)');
  });

  it('draws the inline empty line as a flush panel row, not a dashed box (@ui:11.19)', () => {
    // The dashboard's empty panels show one muted line under their own header (UI-R46): the shared
    // `.k-empty` box is the wrong shape there, so the modifier strips the box and keeps the dim ink.
    const inline = CSS.match(/\.k-empty--inline\{[^}]*\}/)?.[0] ?? '';
    expect(inline, 'no .k-empty--inline rule').not.toBe('');
    expect(inline).toContain('border:0');
    expect(inline).toContain('border-radius:0');
    expect(inline).toContain('padding:var(--k-space-3) var(--k-space-7)');
    expect(inline).toContain('text-align:left');
    expect(inline).toContain('font-size:var(--k-text-sm)');
    expect(inline).toContain('overflow-wrap:anywhere');
    // The dim ink comes from `.k-empty`, which clears WCAG AA in every theme (UI-R41).
    expect(rulesFor('.k-empty')).toContain('color:var(--k-text-dim)');
  });

  it('draws the shared page header with a high-contrast boundary and a narrow actions row (@ui:11.22)', () => {
    // One header primitive for the simple panels (Getting Started, Diffs,
    // Usage, Resources, Doctor). The boundary is contrastBorder, not the
    // ordinary border, so it survives a high-contrast theme.
    expect(rulesFor('.k-pagehead')).toContain(
      'border-bottom:var(--k-border-w) solid var(--k-border-strong)',
    );
    expect(CSS).toContain(
      '@media (max-width: 699px){.k-pagehead-actions{flex-basis:100%;margin-left:0;justify-content:flex-start}}',
    );
    // A long unbroken token must wrap instead of forcing horizontal scroll.
    expect(rulesFor('.k-pagehead-title')).toContain('overflow-wrap:anywhere');
    expect(rulesFor('.k-pagehead-sub')).toContain('overflow-wrap:anywhere');
  });

  it('draws a tab strip whose selection survives a high-contrast theme (US-21)', () => {
    expect(rulesFor('.k-tabs')).toContain('display:flex');
    expect(rulesFor('.k-tabs')).toContain('border-bottom:var(--k-border-w) solid var(--k-border)');
    expect(rulesFor('.k-tabs')).toContain('margin-bottom:var(--k-space-6)');
    expect(rulesFor('.k-tab')).toContain('background:transparent');
    expect(rulesFor('.k-tab')).toContain('color:var(--k-text-dim)');
    expect(rulesFor('.k-tab')).toContain(
      'border-radius:var(--k-radius-sm) var(--k-radius-sm) 0 0',
    );
    expect(CSS).toContain('.k-tab[aria-selected="true"]');
    // The underline is contrastActiveBorder when the theme supplies it, so a
    // selected tab is never just another dim label in High Contrast.
    expect(CSS).toContain(
      'border-bottom-color:var(--vscode-contrastActiveBorder,var(--k-link))',
    );
  });

  it('draws a sortable table header as the header itself (US-25)', () => {
    const sort = rulesFor('.k-sort');
    expect(sort).toContain('text-transform:uppercase');
    expect(sort).toContain('letter-spacing:var(--k-chip-tracking)');
    expect(sort).toContain('font-size:var(--k-text-2xs)');
    expect(sort).toContain('color:inherit');
    expect(sort).toContain('display:inline-flex');
    expect(CSS).toContain('.k-sort:hover{color:var(--k-text)}');
  });

  it('gives a light-theme input an edge that reaches 3:1 non-text contrast (SET-57, C5)', () => {
    // Light Modern's --vscode-input-border is 1.57:1 on white: the
    // light edge comes from a mid-grey theme colour instead. A variable, not a
    // border-color override, so the hover and aria-invalid rules still win.
    expect(rulesFor('.k-input')).toContain(
      'border:var(--k-border-w) solid var(--k-input-edge, var(--vscode-input-border, var(--k-border)))',
    );
    expect(CSS).toMatch(
      /body\.vscode-light\{[^}]*--k-input-edge:var\(--vscode-input-placeholderForeground, var\(--k-text-dim\)\)/,
    );
    // Hover must not fade the light edge under 3:1 (--k-border-strong is the panel border there).
    expect(CSS).toMatch(/body\.vscode-light\{[^}]*--k-input-edge-hover:var\(--k-text\)/);
    expect(rulesFor('.k-input:hover')).toContain('border-color:var(--k-input-edge-hover, var(--k-border-strong))');
  });

  it('emits valid, balanced CSS', () => {
    const opens = (CSS.match(/\{/g) ?? []).length;
    const closes = (CSS.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(CSS).not.toContain(';;');
  });

  it('holds every editor webview at the 320 px page floor, with the sidebar opt-out (UI-R43, UI-R49)', () => {
    // Below the floor the page keeps its 320 px layout and scrolls sideways.
    // The rule sits on the document root, so one base rule reaches every
    // webview that carries the design-system marker; the side bar view is
    // narrower than the floor by design and opts out (D860).
    expect(CSS).toContain('html:not([data-k-floor="off"]){min-inline-size:var(--k-page-floor)}');
    // A clipping root would hide the content the floor exists to keep.
    expect(CSS).not.toMatch(/overflow-x\s*:\s*hidden/);
  });
});

describe('webview CSS success overrides (tier 3 only)', () => {
  it('no webview.html defines an .is-success rule — only the shared primitives do', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const uiDir = join(__dirname, '..', 'ui');
    const offenders: string[] = [];
    for (const dir of readdirSync(uiDir)) {
      const file = join(uiDir, dir, 'webview.html');
      if (!existsSync(file)) continue;
      const html = readFileSync(file, 'utf8');
      const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1] ?? '')
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/[^{}<>;]*\.is-success[^{}]*\{/g)) offenders.push(`${dir}: ${m[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('renders a disabled primary neutral at full opacity, with no local opacity (ST-20, SG-20)', () => {
    const rule = CSS.match(/\.k-btn--primary:disabled,\.k-btn--primary\[aria-disabled="true"\]\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('background:var(--k-surface-sunken)');
    expect(rule).toContain('border:var(--k-border-w) solid var(--k-border)');
    expect(rule).toContain('color:var(--k-text-dim)');
    expect(rule).toContain('opacity:1');
    expect(CSS).toContain('.k-btn:disabled{opacity:.45');
    // Equal specificity: the later rule wins, so the primary rule must come after the generic one.
    expect(CSS.indexOf('.k-btn--primary:disabled,')).toBeGreaterThan(CSS.indexOf('.k-btn:disabled{opacity:.45'));
  });

  it('draws a select chevron as an element, never a data: URL image (ST-1)', () => {
    expect(CSS).toContain('.k-select-chev{');
    expect(rulesFor('.k-select-chev')).toContain('pointer-events:none');
    expect(CSS).not.toMatch(/url\(\s*["']?data:/);
  });
});
