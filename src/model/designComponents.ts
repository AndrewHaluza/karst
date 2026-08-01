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
 * "Delete agent" rendered identically to "Cancel"; and `onboarding` applied a
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

/** The primitive stylesheet. */
export function componentsCss(): string {
  return [
    FOUNDATION,
    BUTTON,
    ICON_BUTTON,
    LINK,
    INPUT,
    SWITCH,
    CHIP,
    DOT,
    SPINNER,
    OVERLAY,
    TOAST,
    EMPTY,
    REDUCED_MOTION,
  ].join('\n');
}

// ── Foundation ───────────────────────────────────────────────────────────────
// One focus ring for the whole product. `sidebar` and `welcome` defined NO
// :focus-visible rule at all, so a keyboard user had no visible focus anywhere
// in them; `usage` covered only the bare `button` selector.
const FOUNDATION = `
.k-focusable:focus-visible,
.k-btn:focus-visible,.k-iconbtn:focus-visible,.k-link:focus-visible,
.k-input:focus-visible,.k-switch:focus-visible,.k-chip:focus-visible,
.k-toast-close:focus-visible{
  outline:var(--k-focus-w) solid var(--k-focus);outline-offset:var(--k-focus-offset)}
.k-input:focus{outline:var(--k-focus-w) solid var(--k-focus);outline-offset:var(--k-focus-offset)}
`.trim();

// ── Button ───────────────────────────────────────────────────────────────────
const BUTTON = `
.k-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:var(--k-space-3);
  font-family:inherit;font-size:var(--k-text-xs);font-weight:var(--k-weight-medium);
  line-height:var(--k-leading-tight);
  min-height:var(--k-control-h-md);padding:var(--k-space-2) var(--k-space-6);
  border:var(--k-border-w) solid transparent;border-radius:var(--k-radius-sm);
  background:var(--k-action-bg);color:var(--k-action-fg);
  cursor:pointer;position:relative;
  transition:background var(--k-dur-fast) var(--k-ease-standard),
             color var(--k-dur-fast) var(--k-ease-standard),
             border-color var(--k-dur-fast) var(--k-ease-standard)}
.k-btn--sm{min-height:var(--k-control-h-sm);padding:var(--k-space-1) var(--k-space-4);font-size:var(--k-text-xs)}
.k-btn--lg{min-height:var(--k-control-h-lg);padding:var(--k-space-3) var(--k-space-7);font-size:var(--k-text-md)}

.k-btn--primary{background:var(--k-action-bg);color:var(--k-action-fg)}
.k-btn--primary:hover{background:var(--k-action-bg-hover)}

.k-btn--secondary{background:var(--k-action-2-bg);color:var(--k-action-2-fg);border-color:var(--k-border)}
.k-btn--secondary:hover{background:var(--k-action-2-bg-hover)}

.k-btn--ghost{background:transparent;color:var(--k-text-dim);border-color:var(--k-border)}
.k-btn--ghost:hover{background:var(--k-surface-hover);color:var(--k-text)}

.k-btn--danger{background:transparent;color:var(--k-danger);border-color:var(--k-danger)}
.k-btn--danger:hover{background:var(--k-danger);color:var(--k-danger-fg)}

.k-btn--link{background:transparent;color:var(--k-link);border-color:transparent;
  padding:var(--k-space-0);min-height:var(--k-space-0)}
.k-btn--link:hover{color:var(--k-link-active);text-decoration:underline}

.k-btn:active:not(:disabled){transform:scale(.96)}
.k-btn:disabled{opacity:.45;cursor:default}
.k-btn[aria-busy="true"]{cursor:progress}
.k-btn[aria-busy="true"]::before{
  content:"";flex:none;
  width:var(--k-spinner-size);height:var(--k-spinner-size);
  border:var(--k-spinner-w) solid currentColor;border-top-color:transparent;
  border-radius:var(--k-radius-circle);
  animation:k-spin var(--k-dur-spin) linear infinite}
.k-btn.is-success:not(.k-btn--row){color:var(--k-success);border-color:var(--k-success)}
.k-btn.is-success:not(.k-btn--row)::before{
  content:"\\2713";flex:none;border:0;animation:none;width:auto;height:auto}

/* The ROW modifier — composed WITH a variant (\`k-btn--ghost k-btn--row\`), never
   instead of one. It says "this control is a row in a list", and the only thing
   it changes is how the row reports success.

   The button-shaped flash is a check glyph in the leading slot plus a
   --k-success border. A row is not button-shaped: it is full-width, often its
   own grid, and its content is the data. So the glyph was auto-placed into that
   grid — landing beside the diff view's status letter, which read as "M ✓", and
   pushing the path onto a second line — while the border boxed the whole row
   green. Every click on a list item or a file row animated that in and out.

   Success still has to be VISIBLE (UI-R13), and for these rows it is a handoff:
   an editor or a panel opens, and the flash only has to say "that one". So it
   becomes the row's own highlight — the same wash the platform uses for a
   selected row — which is a state a row already has a vocabulary for.

   Scoped off at the source above rather than overridden here: an override would
   need a border-color VALUE, and a row composes with ghost (hairline), link (no
   border) and secondary, which do not share one. */
.k-btn--row{justify-content:flex-start;width:100%;text-align:left}
.k-btn--row.is-success{background:var(--k-surface-selected)}
.k-btn--row.is-success::before{content:none}
`.trim();

// ── Icon button ──────────────────────────────────────────────────────────────
// Square, and never below the WCAG 2.2 §2.5.8 pointer target. Every icon-only
// control needs `aria-label` AND a matching `title` (UI-R19/R21/R24) — markup
// the stylesheet cannot enforce, which is why the rules carry a Check for it.
const ICON_BUTTON = `
.k-iconbtn{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:var(--k-hit-min);min-height:var(--k-hit-min);
  padding:var(--k-space-1);
  border:var(--k-border-w) solid transparent;border-radius:var(--k-radius-sm);
  background:transparent;color:var(--k-text-dim);cursor:pointer;position:relative;
  transition:background var(--k-dur-fast) var(--k-ease-standard),
             color var(--k-dur-fast) var(--k-ease-standard)}
.k-iconbtn:hover{background:var(--k-surface-hover);color:var(--k-text)}
.k-iconbtn--danger{color:var(--k-danger)}
.k-iconbtn--danger:hover{background:var(--k-danger);color:var(--k-danger-fg)}
.k-iconbtn:active:not(:disabled){transform:scale(.96)}
.k-iconbtn:disabled{opacity:.45;cursor:default}
.k-iconbtn[aria-busy="true"]{cursor:progress}
.k-iconbtn[aria-busy="true"] > *{visibility:hidden}
.k-iconbtn[aria-busy="true"]::after{
  content:"";position:absolute;
  width:var(--k-spinner-size);height:var(--k-spinner-size);
  border:var(--k-spinner-w) solid currentColor;border-top-color:transparent;
  border-radius:var(--k-radius-circle);
  animation:k-spin var(--k-dur-spin) linear infinite}
.k-iconbtn.is-success{color:var(--k-success)}
`.trim();

// ── Link ─────────────────────────────────────────────────────────────────────
const LINK = `
.k-link{color:var(--k-link);text-decoration:none;border-radius:var(--k-radius-xs)}
.k-link:hover{color:var(--k-link-active);text-decoration:underline}
.k-link:active{color:var(--k-link-active)}
`.trim();

// ── Input / field ────────────────────────────────────────────────────────────
const INPUT = `
.k-input{
  font-family:inherit;font-size:var(--k-text-md);color:var(--k-text);
  background:var(--k-surface);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-sm);
  padding:var(--k-space-2) var(--k-space-4);
  transition:border-color var(--k-dur-fast) var(--k-ease-standard)}
.k-input:hover:not(:disabled){border-color:var(--k-border-strong)}
.k-input:disabled{opacity:.45;color:var(--k-text-faint);cursor:default}
.k-input[aria-busy="true"]{cursor:progress}
.k-input[aria-invalid="true"]{border-color:var(--k-danger)}

.k-field{display:flex;flex-direction:column;gap:var(--k-space-2)}
.k-field > label{font-size:var(--k-text-xs);color:var(--k-text-dim)}
.k-field-error{font-size:var(--k-text-xs);color:var(--k-danger)}
.k-field-help{font-size:var(--k-text-xs);color:var(--k-text-faint)}
`.trim();

// ── Switch ───────────────────────────────────────────────────────────────────
const SWITCH = `
.k-switch{
  display:inline-flex;align-items:center;gap:var(--k-space-3);
  cursor:pointer;font-size:var(--k-text-xs);color:var(--k-text-dim);
  background:transparent;border:0;padding:var(--k-space-0)}
.k-switch-track{
  flex:none;width:var(--k-space-9);height:var(--k-space-7);
  border-radius:var(--k-radius-pill);background:var(--k-surface-sunken);
  border:var(--k-border-w) solid var(--k-border);position:relative;
  transition:background var(--k-dur-fast) var(--k-ease-standard)}
.k-switch-track::after{
  content:"";position:absolute;top:var(--k-space-1);left:var(--k-space-1);
  width:var(--k-space-5);height:var(--k-space-5);
  border-radius:var(--k-radius-circle);background:var(--k-text-dim);
  transition:transform var(--k-dur-fast) var(--k-ease-standard)}
.k-switch[aria-checked="true"] .k-switch-track{background:var(--k-action-bg);border-color:transparent}
.k-switch[aria-checked="true"] .k-switch-track::after{
  transform:translateX(var(--k-space-5));background:var(--k-action-fg)}
.k-switch:hover .k-switch-track{border-color:var(--k-border-strong)}
.k-switch:active .k-switch-track{transform:scale(.96)}
.k-switch:disabled{opacity:.45;cursor:default}
.k-switch[aria-busy="true"]{cursor:progress}
`.trim();

// ── Chip ─────────────────────────────────────────────────────────────────────
// One pill shape at one radius. Six divergent pill shapes existed across the
// webviews (`keypill`, `fixtoggle`, `approach .aid`, `pr .pst`, repo `chip`,
// `delta`) at three different radii.
const CHIP = `
.k-chip{
  display:inline-flex;align-items:center;gap:var(--k-space-2);
  font-family:inherit;font-size:var(--k-text-xs);line-height:var(--k-leading-tight);
  padding:var(--k-space-1) var(--k-space-4);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-pill);
  background:transparent;color:var(--k-text-dim);
  transition:background var(--k-dur-fast) var(--k-ease-standard)}
button.k-chip{cursor:pointer}
.k-chip:hover{background:var(--k-surface-hover);color:var(--k-text)}
.k-chip[aria-pressed="true"],.k-chip[aria-checked="true"],.k-chip[aria-selected="true"]{
  background:var(--k-action-bg);color:var(--k-action-fg);border-color:transparent}
.k-chip:active{transform:scale(.96)}
.k-chip:disabled{opacity:.45;cursor:default}
.k-chip[aria-busy="true"]{cursor:progress}
.k-chip.is-success{border-color:var(--k-success);color:var(--k-success)}
`.trim();

// ── Status dot ───────────────────────────────────────────────────────────────
// Non-interactive, and never the only carrier of meaning (UI-R28): the markup
// supplies role="img" plus an aria-label naming the status in words.
const DOT = `
.k-dot{
  display:inline-block;flex:none;
  width:var(--k-space-4);height:var(--k-space-4);
  border-radius:var(--k-radius-circle);background:var(--k-pending)}
.k-dot--running{background:var(--k-running)}
.k-dot--attention{background:var(--k-attention)}
.k-dot--passed{background:var(--k-passed)}
.k-dot--failed{background:var(--k-failed)}
`.trim();

// ── Spinner ──────────────────────────────────────────────────────────────────
const SPINNER = `
@keyframes k-spin{to{transform:rotate(360deg)}}
.k-spinner{
  display:inline-block;flex:none;
  width:var(--k-spinner-size);height:var(--k-spinner-size);
  border:var(--k-spinner-w) solid currentColor;border-top-color:transparent;
  border-radius:var(--k-radius-circle);
  animation:k-spin var(--k-dur-spin) linear infinite}
`.trim();

// ── Modal / drawer ───────────────────────────────────────────────────────────
// A destructive action's CONFIRMATION is never one of these — it is a host-side
// VS Code modal, so a crafted webview message cannot skip it (UI-R33).
const OVERLAY = `
.k-scrim{position:fixed;inset:0;background:var(--k-scrim);z-index:var(--k-z-scrim)}
.k-modal{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:var(--k-z-modal);
  background:var(--k-surface);color:var(--k-text);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-xl);
  box-shadow:var(--k-elev-3);padding:var(--k-space-7)}
.k-drawer{
  position:fixed;top:0;right:0;bottom:0;z-index:var(--k-z-drawer);
  background:var(--k-surface);color:var(--k-text);
  border-left:var(--k-border-w) solid var(--k-border);
  box-shadow:var(--k-elev-2);
  transition:transform var(--k-dur-slow) var(--k-ease-out)}
.k-modal-title{font-size:var(--k-text-lg);font-weight:var(--k-weight-semibold);
  margin:var(--k-space-0) var(--k-space-0) var(--k-space-5)}
.k-modal-actions{display:flex;justify-content:flex-end;gap:var(--k-space-4);
  margin-top:var(--k-space-7)}
`.trim();

// ── Toast ────────────────────────────────────────────────────────────────────
// The one polite live region per webview. An ERROR never auto-dismisses: a
// failure the user has not read is not a failure that has been reported.
const TOAST = `
.k-toast-root{
  position:fixed;right:var(--k-space-7);bottom:var(--k-space-7);
  z-index:var(--k-z-toast);
  display:flex;flex-direction:column;gap:var(--k-space-3);
  max-width:var(--k-toast-max-w,none)}
.k-toast{
  padding:var(--k-space-4) var(--k-space-6);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-md);
  background:var(--k-surface);color:var(--k-text);
  box-shadow:var(--k-elev-3);font-size:var(--k-text-md);
  animation:k-toast-in var(--k-dur-base) var(--k-ease-out)}
@keyframes k-toast-in{from{opacity:0;transform:translateY(var(--k-space-2))}to{opacity:1}}
.k-toast--success{border-color:var(--k-success)}
.k-toast--warning{border-color:var(--k-warning)}
.k-toast--error{border-color:var(--k-danger);color:var(--k-danger)}
.k-toast--info{border-color:var(--k-info)}
.k-toast-close{background:transparent;border:0;color:inherit;cursor:pointer;
  margin-left:var(--k-space-4)}
`.trim();

// ── Empty state ──────────────────────────────────────────────────────────────
// Never a grid of zeros: "0" asserts a measurement, absence is a different claim.
const EMPTY = `
.k-empty{
  border:var(--k-border-w) dashed var(--k-border);border-radius:var(--k-radius-xl);
  padding:var(--k-space-9) var(--k-space-8);text-align:center;color:var(--k-text-dim)}
.k-empty-title{font-size:var(--k-text-md);color:var(--k-text);margin-bottom:var(--k-space-2)}
.k-empty-hint{font-size:var(--k-text-sm)}
`.trim();

// ── Reduced motion ───────────────────────────────────────────────────────────
// Nothing is lost when motion is off: pending is carried by `aria-busy` and the
// disabled control, not by the spinner's rotation.
const REDUCED_MOTION = `
@media (prefers-reduced-motion: reduce){
  .k-btn,.k-iconbtn,.k-input,.k-chip,.k-switch,.k-switch-track,
  .k-switch-track::after,.k-drawer,.k-toast{transition:none}
  .k-spinner,.k-btn[aria-busy="true"]::before,.k-iconbtn[aria-busy="true"]::after,
  .k-toast{animation:none}
  .k-btn:active:not(:disabled),.k-iconbtn:active:not(:disabled),
  .k-chip:active,.k-switch:active .k-switch-track{transform:none}
}
`.trim();
