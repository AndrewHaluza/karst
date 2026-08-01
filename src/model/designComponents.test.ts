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
    // onboarding applied `.ghost` to #attachBtn and no stylesheet defined it, so
    // the "ghost" button silently rendered as a primary.
    expect(CSS).toContain('.k-btn--ghost');
    expect(rulesFor('.k-btn--ghost').length).toBeGreaterThan(0);
  });

  it('reports success on a row-shaped control as a wash, never a badge (UI-R13)', () => {
    // The button-shaped success flash is a check glyph in the leading slot plus
    // a --k-success border. On a ROW — a sidebar ticket, a diff file — that
    // glyph is auto-placed into the row's own grid: it wrapped the path onto a
    // second line and landed beside the status letter as "M ✓", inside a green
    // box, for every click. The outcome still has to be visible (UI-R13), so
    // the row variant keeps a flash and makes it the row's own highlight.
    // Only the rules the row variant OWNS — `rulesFor` would also return the
    // `:not(.k-btn--row)` exclusions, which mention --k-success by design.
    const row = (CSS.match(/^\.k-btn--row[^{}]*\{[^}]*\}/gm) ?? []).join('\n');
    expect(row, 'the row variant has no success rule').toContain('.k-btn--row.is-success');
    expect(row, 'the row flash is not the shared selection wash').toContain('var(--k-surface-selected)');
    expect(row, 'the row still grows a check badge').toContain('content:none');
    expect(row, 'the row still recolours its border').not.toContain('var(--k-success)');
    // Scoped off at the source, not overridden after the fact: a later
    // `border-color` override would need a value, and any value it picked would
    // be wrong for one of the variants a row composes with.
    expect(CSS, 'the badge treatment still reaches rows').toContain('.k-btn.is-success:not(.k-btn--row)');
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
