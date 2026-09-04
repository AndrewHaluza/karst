/**
 * The design system's primitives (§ `docs/ui/DESIGN-SYSTEM.md` §4) — the only
 * legal controls in the UI (UI-R07).
 *
 * Seven webviews independently invented the same controls. Measured before this
 * existed: the primary button had FOUR different `border-radius` values
 * (`diffs` 2px, `welcome` 3px, `sidebar` 4px, `usage` 5px) for what every file
 * described as "the button that uses `--vscode-button-background`"; `sidebar`'s
 * `.tool` and `.ia` were two icon buttons with different box sizes, radii and
 * hover alphas IN ONE FILE; `settings` had no destructive styling at all, so
 * "Delete agent" rendered identically to "Cancel"; and `ticketForm` applied a
 * `.ghost` class that no stylesheet anywhere defined, so the ghost button
 * silently rendered as a primary.
 *
 * Every rule here is expressed in [[designTokens]] values only — no hex, no raw
 * length, no raw duration. `designComponents.test.ts` enforces that literally,
 * which is what makes UI-R04 checkable rather than aspirational.
 *
 * The pending state hangs off `[aria-busy="true"]`, not a bespoke class, so the
 * accessible signal and the visible signal cannot diverge: a control cannot look
 * busy without announcing it, or announce it without looking it. [[designRuntime]]
 * is the only thing that sets it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Primitive class names, in the order the design system documents them. */
export const PRIMITIVES = [
  '.k-btn',
  '.k-iconbtn',
  '.k-link',
  '.k-input',
  '.k-field',
  '.k-switch',
  '.k-chip',
  '.k-dot',
  '.k-modal',
  '.k-drawer',
  '.k-toast',
  '.k-empty',
] as const;

/**
 * The tooltip is deliberately NOT in that list: it is the native `title`
 * attribute (§ DESIGN-SYSTEM 4.13), so it has no rule to define. That choice
 * buys keyboard reachability through the platform, survival under CSP with no
 * JS, and no positioning logic — at the cost of styling, which is the right
 * trade for a hint. Its contract (required where, ≤80 chars, identical to
 * `aria-label` on icon-only controls) is markup, enforced by UI-R19–R22.
 */

/**
 * The state selectors every interactive primitive must carry.
 *
 * `default` is the base rule and needs no selector. `error` is absent here on
 * purpose: for a BUTTON the failure is reported by a toast and the control
 * returns to default (a red button with no message is not a report), so the
 * error state belongs to `.k-input[aria-invalid]` and `.k-toast--error`, not to
 * `.k-btn`.
 */
export const STATE_MATRIX = [
  ':hover',
  ':focus-visible',
  ':active',
  '[aria-busy="true"]',
  ':disabled',
  '.is-success',
] as const;

/** Placeholder swapped for the primitives; sits at the TOP of each webview's `<style>`. */
export const DS_CSS_MARKER = '/*KARST_DS_CSS*/';

/**
 * The primitive stylesheet. Lives as a real sibling `.css` file
 * (`designComponents.webview.css`) — a linter, formatter and editor can
 * process it — rather than as a TS template-literal string; read at call
 * time the same way `extension.ts` reads the `webview.html` documents
 * (`scripts/copy-assets.mjs` carries it next to the compiled output).
 */
export function componentsCss(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/designComponents.webview.css'), 'utf8').trim();
}
