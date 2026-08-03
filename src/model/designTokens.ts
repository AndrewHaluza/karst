/**
 * The design system's token layer (§ `docs/ui/DESIGN-SYSTEM.md`) — the only
 * legal style values in the UI (UI-R04).
 *
 * Seven self-contained `webview.html` documents each grew their own copy of
 * every value, because CSP forbids a shared stylesheet and nothing stopped the
 * duplication. Measured before this existed: six greens, five reds, three
 * purples, ~1050 raw `px` literals over 24 magnitudes, ~30 distinct font sizes,
 * and four different `border-radius` values for what every file called "the
 * button that uses `--vscode-button-background`". Worse than any single value
 * was that `var(--vscode-testing-iconPassed, …)` was written with fallback
 * `#73c991` in one file and `#3fb950` in another — the SAME theme variable
 * rendering two colours on any theme that omits it.
 *
 * Delivery is [[palette]]'s and [[providerIdentity]]'s existing mechanism, not a
 * new one: a marker in the HTML, a TS module emitting text, one host-side
 * inject call. See [[designSystem]].
 *
 * Every token is named for MEANING, never for hue or value. `--k-danger`, not
 * `--k-red`; `--k-space-4`, not `--k-space-8px` — a token named for its value is
 * a token that can never change. `designTokens.test.ts` holds both true, along
 * with the one-value-one-token and one-variable-one-fallback invariants that are
 * the actual defect this replaces.
 *
 * The status ramp (`--k-pending|running|attention|passed|failed`) is NOT here.
 * It belongs to [[palette]] and is CONSUMED — the feedback aliases below are
 * how a component asks for "green" without there being a second green to pick.
 */

/**
 * Token name → value. Ordered by category for readability only; the emitted
 * `:root` block preserves this order, and a duplicate name is impossible
 * because this is an object.
 */
export const DESIGN_TOKENS: Readonly<Record<string, string>> = {
  // ── Surface ────────────────────────────────────────────────────────────────
  '--k-bg': 'var(--vscode-editor-background)',
  '--k-surface': 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
  '--k-surface-hover': 'var(--vscode-list-hoverBackground, rgba(127,127,127,.16))',
  // A row that is selected, or that was just acted on. The INACTIVE selection
  // wash on purpose: the active one is a saturated fill themes pair with their
  // own foreground, and a row keeps `--k-text` — so the active variant is the
  // one that can fail contrast (UI-R29). This is also what a row's success
  // flash uses, because "I just opened this" is selection, not "passed".
  '--k-surface-selected':
    'var(--vscode-list-inactiveSelectionBackground, var(--k-surface-hover))',
  '--k-surface-sunken': 'var(--vscode-editor-background)',
  '--k-border': 'var(--vscode-panel-border, rgba(128,128,128,.35))',
  '--k-border-strong': 'var(--vscode-contrastBorder, var(--vscode-panel-border))',

  // ── Text ───────────────────────────────────────────────────────────────────
  '--k-text': 'var(--vscode-foreground)',
  '--k-text-dim': 'var(--vscode-descriptionForeground, var(--vscode-foreground))',
  '--k-text-faint': 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
  '--k-link': 'var(--vscode-textLink-foreground)',
  '--k-link-active': 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))',

  // ── Action ─────────────────────────────────────────────────────────────────
  '--k-action-bg': 'var(--vscode-button-background)',
  '--k-action-fg': 'var(--vscode-button-foreground)',
  '--k-action-bg-hover': 'var(--vscode-button-hoverBackground, var(--vscode-button-background))',
  '--k-action-2-bg': 'var(--vscode-button-secondaryBackground)',
  '--k-action-2-fg': 'var(--vscode-button-secondaryForeground)',
  '--k-action-2-bg-hover':
    'var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground))',
  '--k-focus': 'var(--vscode-focusBorder)',

  // ── Feedback ───────────────────────────────────────────────────────────────
  // Aliases onto [[palette]]'s ramp. This is what kills the six greens: a
  // component that needs "success" has exactly one thing to ask for, and the
  // decision of what colour that is lives in one file.
  '--k-success': 'var(--k-passed)',
  '--k-warning': 'var(--k-attention)',
  '--k-danger': 'var(--k-failed)',
  '--k-info': 'var(--k-running)',
  // Text ON a filled feedback surface. Paired deliberately (UI-R29): contrast is
  // guaranteed by using the pair, never by hand-picking a foreground — which is
  // how `background:#8957e5;color:#fff` reached the dashboard.
  '--k-success-fg': 'var(--vscode-editor-background)',
  '--k-danger-fg': 'var(--vscode-editor-background)',

  // ── Data series ────────────────────────────────────────────────────────────
  // Categorical hues for a chart with more than one series — NOT status. The
  // usage view breaks spend down by stage AND by model side by side, and those
  // are two different questions: collapsing both onto `--k-info` makes the
  // comparison unreadable, which is what happens when the only blue available
  // is the one that means "running". Ordered, and used in order.
  '--k-series-1': 'var(--k-info)',
  '--k-series-2': 'var(--vscode-charts-purple, #8a63d2)',

  // ── Spacing ────────────────────────────────────────────────────────────────
  // Derived from the measured distribution; the scale is closed. `1px` is
  // deliberately absent — it is a border width (`--k-border-w`), and admitting
  // it here is how a hairline becomes indistinguishable from a gap.
  '--k-space-0': '0',
  '--k-space-1': '2px',
  '--k-space-2': '4px',
  '--k-space-3': '6px',
  '--k-space-4': '8px',
  '--k-space-5': '10px',
  '--k-space-6': '12px',
  '--k-space-7': '16px',
  '--k-space-8': '20px',
  '--k-space-9': '26px',

  // ── Radius ─────────────────────────────────────────────────────────────────
  '--k-radius-xs': '3px',
  '--k-radius-sm': '5px',
  '--k-radius-md': '6px',
  '--k-radius-lg': '9px',
  '--k-radius-xl': '12px',
  '--k-radius-pill': '999px',
  '--k-radius-circle': '50%',

  // ── Typography ─────────────────────────────────────────────────────────────
  '--k-font-ui':
    'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif)',
  '--k-font-mono':
    'var(--vscode-editor-font-family, "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)',
  // Nine steps replace ~30 ad-hoc sizes. 9/9.5/10.5/12.5px are REMOVED rather
  // than tokenized: they were rounding noise between neighbours, not intent.
  '--k-text-2xs': '10px',
  '--k-text-xs': '11px',
  '--k-text-sm': '11.5px',
  '--k-text-md': '12px',
  '--k-text-base': 'var(--vscode-font-size, 13px)',
  '--k-text-lg': '14px',
  '--k-text-xl': '17px',
  '--k-text-2xl': '20px',
  '--k-weight-normal': '400',
  '--k-weight-medium': '500',
  '--k-weight-semibold': '600',
  '--k-leading-tight': '1.15',
  '--k-leading-normal': '1.45',

  // ── Elevation ──────────────────────────────────────────────────────────────
  '--k-elev-0': 'none',
  '--k-elev-1': '0 1px 2px rgba(0,0,0,.18)',
  '--k-elev-2': '0 4px 12px rgba(0,0,0,.28)',
  '--k-elev-3': '0 8px 28px rgba(0,0,0,.35)',
  '--k-scrim': 'rgba(0,0,0,.45)',

  // ── Motion ─────────────────────────────────────────────────────────────────
  '--k-dur-fast': '120ms',
  '--k-dur-base': '180ms',
  '--k-dur-slow': '280ms',
  '--k-dur-spin': '900ms',
  '--k-dur-flash-copy': '1200ms',
  '--k-dur-flash-done': '2400ms',
  '--k-ease-standard': 'cubic-bezier(.2,0,.2,1)',
  '--k-ease-out': 'cubic-bezier(0,0,.2,1)',

  // ── Sizing ─────────────────────────────────────────────────────────────────
  '--k-border-w': '1px',
  '--k-control-h-sm': '22px',
  '--k-control-h-md': '26px',
  '--k-control-h-lg': '30px',
  // WCAG 2.2 §2.5.8 (AA) minimum pointer target.
  '--k-hit-min': '24px',
  '--k-focus-w': '1px',
  '--k-focus-offset': '1px',
  // The spinner ring. Distinct from `--k-border-w`: a 1px ring reads as a
  // rendering artefact at these control sizes rather than as motion.
  '--k-spinner-w': '2px',
  '--k-spinner-size': '12px',

  // ── Layering ───────────────────────────────────────────────────────────────
  '--k-z-scrim': '30',
  '--k-z-drawer': '40',
  '--k-z-modal': '50',
  '--k-z-toast': '60',
  '--k-z-tooltip': '70',
};

/** Every declared token name, in emission order. */
export function tokenNames(): string[] {
  return Object.keys(DESIGN_TOKENS);
}

/**
 * The `:root` block. Emitted at the TOP of each webview's own `<style>` so a
 * file-local rule can still override a primitive while that screen is being
 * migrated; a fully remediated screen has nothing left to override.
 */
export function tokensCss(): string {
  const body = Object.entries(DESIGN_TOKENS)
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  return `:root{${body}}`;
}
