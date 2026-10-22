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
    expect(CSS, 'a raw length survived').not.toMatch(/(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b/);
    expect(CSS, 'a raw duration survived').not.toMatch(/(?<![\w-])\d+(?:\.\d+)?(?:ms|s)\b/);
  });

  it('gives every focusable primitive the one focus ring (UI-R23)', () => {
    // sidebar and welcome had no :focus-visible rule at all; usage covered only
    // bare `button`. One ring, defined once, reaches all seven webviews.
    for (const cls of ['.k-btn', '.k-iconbtn', '.k-link', '.k-input', '.k-switch', '.k-chip']) {
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
    expect(CSS).not.toMatch(/pointer-events:\s*none/);
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

  it('emits valid, balanced CSS', () => {
    const opens = (CSS.match(/\{/g) ?? []).length;
    const closes = (CSS.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(CSS).not.toContain(';;');
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
});
