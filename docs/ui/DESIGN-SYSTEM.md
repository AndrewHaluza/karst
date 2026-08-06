# Karst Design System

The single source of truth for what Karst's UI is made of: **tokens** (the only
legal style values), **primitives** (the only legal controls), and the **state
matrix** each primitive must express.

This document defines *what exists*. [UI-RULES.md](./UI-RULES.md) defines *what
an agent must do* and is the enforceable contract. [STYLE-GUIDE.md](./STYLE-GUIDE.md)
defines *how to apply it*.

---

## 0. Why this exists (the measured problem)

Karst's UI is seven self-contained `webview.html` documents. CSP forbids a shared
stylesheet or script, so every file grew its own copy of everything. Measured
across `src/ui/*/webview.html` before remediation:

| Symptom | Measurement |
|---|---|
| No shared color source | **6 distinct greens** (`#73c991 #4bb64b #2ea043 #89d185 #81b88b #3fb950`), **5 reds**, **3 purples** for related meanings |
| No spacing scale | **~1050** raw `px` literals across 24 distinct magnitudes |
| No type scale | **~30** distinct `font-size` values, incl. `9px 9.5px 10px 10.5px 11px 11.5px` |
| No shared primitive | at least **6** rounded-pill/chip shapes at 3 different radii; **3** circular "node" treatments encoding overlapping status |
| No pending feedback | **0** occurrences of `aria-busy` in the entire UI |
| Partial token adoption | 3 of 7 webviews (`usage`, `diffs`, `welcome`) carry **no** `/*KARST_PALETTE*/` marker, so they are outside even the one shared block that already existed |

The delivery mechanism is not new. `src/model/palette.ts` and
`src/model/providerIdentity.ts` already prove the pattern: **a marker in the HTML,
a TS module that emits CSS/JS text, and a host-side inject call.** This design
system extends exactly that mechanism rather than inventing a second one — and
no UI framework or component library is introduced (see [UI-RULES.md](./UI-RULES.md) §R-0).

---

## 1. Delivery

| Artifact | Location |
|---|---|
| Token + primitive definitions (TS) | `src/model/designSystem.ts` |
| CSS marker (first line inside each `<style>`) | `/*KARST_DS_CSS*/` |
| JS marker (first statement inside each `<script>`) | `/*KARST_DS_JS*/` |
| Injector | `injectDesignSystem(html)` |

Ordering is load-bearing:

- `/*KARST_DS_CSS*/` sits at the **top** of the file's own `<style>`, so a
  file-local rule can still override a primitive during migration. Once a
  screen is remediated it must have nothing left to override.
- `/*KARST_PALETTE*/` continues to sit in the **trailing** `<style>` block, so
  the `--k-*` status ramp wins the cascade. The design system consumes that ramp;
  it does not redefine it.
- `/*KARST_DS_JS*/` must be injected **before** `injectCsp`, so the nonce pass
  authorizes it.

Every webview carries both markers. `src/ui/designSystem.test.ts` discovers the
webview directories rather than listing them (same rationale as
`ui/webviewCsp.test.ts`): a webview added later cannot ship outside the system
without a failing test.

---

## 2. Tokens

Tokens are CSS custom properties emitted into `:root`. **A token is the only
legal style value.** No component may contain a raw hex, a raw `px` spacing or
font size, a raw radius, or a raw duration.

Values resolve to VS Code theme variables wherever a theme variable expresses
the intent, with a hex fallback for the case where the host theme omits it. That
is what makes the UI track the user's theme instead of imposing a palette.

### 2.1 Color

Colors are **semantic**, never literal. `--k-danger` — never `--k-red`.

#### Surface

| Token | Value | Use |
|---|---|---|
| `--k-bg` | `var(--vscode-editor-background)` | page background |
| `--k-surface` | `var(--vscode-editorWidget-background, var(--vscode-editor-background))` | panels, cards, drawers |
| `--k-surface-hover` | `var(--vscode-list-hoverBackground)` | row/control hover wash |
| `--k-surface-selected` | `var(--vscode-list-inactiveSelectionBackground, var(--k-surface-hover))` | a row that is selected, or that was just acted on (the `.k-btn--row` success flash) |
| `--k-surface-sunken` | `var(--vscode-editor-background)` | wells, progress tracks |
| `--k-border` | `var(--vscode-panel-border, rgba(128,128,128,.35))` | default 1px hairline |
| `--k-border-strong` | `var(--vscode-contrastBorder, var(--vscode-panel-border))` | emphasis / high-contrast themes |

#### Text

| Token | Value | Use |
|---|---|---|
| `--k-text` | `var(--vscode-foreground)` | body |
| `--k-text-dim` | `var(--vscode-descriptionForeground, var(--vscode-foreground))` | secondary, labels, captions |
| `--k-text-faint` | `var(--vscode-disabledForeground, var(--vscode-descriptionForeground))` | disabled, tertiary metadata |
| `--k-link` | `var(--vscode-textLink-foreground)` | links |
| `--k-link-active` | `var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))` | link hover/active |

#### Action

| Token | Value | Use |
|---|---|---|
| `--k-action-bg` | `var(--vscode-button-background)` | primary button fill |
| `--k-action-fg` | `var(--vscode-button-foreground)` | primary button text |
| `--k-action-bg-hover` | `var(--vscode-button-hoverBackground, var(--vscode-button-background))` | primary hover |
| `--k-action-2-bg` | `var(--vscode-button-secondaryBackground)` | secondary fill |
| `--k-action-2-fg` | `var(--vscode-button-secondaryForeground)` | secondary text |
| `--k-action-2-bg-hover` | `var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground))` | secondary hover |
| `--k-focus` | `var(--vscode-focusBorder)` | the focus ring — one value, everywhere |

#### Status (existing ramp — consumed, not redefined)

Emitted today by `src/model/palette.ts`. The design system **must not** declare a
second value for any of these.

| Token | Meaning |
|---|---|
| `--k-pending` | idle · skipped · not yet run · offline |
| `--k-running` | in progress |
| `--k-attention` | needs the user |
| `--k-passed` | succeeded · done · online |
| `--k-failed` | failed · blocked |

#### Feedback (aliases onto the status ramp — this is what kills the 6 greens)

| Token | Value |
|---|---|
| `--k-success` | `var(--k-passed)` |
| `--k-warning` | `var(--k-attention)` |
| `--k-danger` | `var(--k-failed)` |
| `--k-info` | `var(--k-running)` |
| `--k-success-fg` / `--k-danger-fg` | `var(--vscode-editor-background)` — text *on* a filled success/danger surface |

#### Data series (categorical — not status)

| Token | Value |
|---|---|
| `--k-series-1` | `var(--k-info)` |
| `--k-series-2` | `var(--vscode-charts-purple, #8a63d2)` |

For a view with more than one series (the usage view breaks spend down by stage
*and* by model, side by side). Used in order. These are **not** status colours:
`--k-info` means "running", and borrowing it for a second series would make one
colour carry two claims.

> A component that needs "green" uses `--k-success`. There is no second green to
> pick. Ad-hoc `#2ea043` / `#73c991` / `#89d185` are the defect this replaces.

### 2.2 Spacing

Derived from the actual distribution (the six most-used values were `1,6,8,10,12,4`).
The scale is closed — a component may not interpolate between steps.

| Token | Value |
|---|---|
| `--k-space-0` | `0` |
| `--k-space-1` | `2px` |
| `--k-space-2` | `4px` |
| `--k-space-3` | `6px` |
| `--k-space-4` | `8px` |
| `--k-space-5` | `10px` |
| `--k-space-6` | `12px` |
| `--k-space-7` | `16px` |
| `--k-space-8` | `20px` |
| `--k-space-9` | `26px` |

`1px` is **not** a spacing step — it is a border width, `--k-border-w`.

### 2.3 Radius

| Token | Value | Use |
|---|---|---|
| `--k-radius-xs` | `3px` | tiny overlay controls (attachment detach) |
| `--k-radius-sm` | `5px` | buttons, inputs |
| `--k-radius-md` | `6px` | rows, small panels |
| `--k-radius-lg` | `9px` | chips, badges |
| `--k-radius-xl` | `12px` | large panels, drawers, modals |
| `--k-radius-pill` | `999px` | pills, toggle tracks |
| `--k-radius-circle` | `50%` | status dots, nodes |

### 2.4 Typography

| Token | Value |
|---|---|
| `--k-font-ui` | `var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif)` |
| `--k-font-mono` | `var(--vscode-editor-font-family, "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)` |
| `--k-text-2xs` | `10px` — dense metadata only |
| `--k-text-xs` | `11px` — control labels, captions |
| `--k-text-sm` | `11.5px` — secondary body |
| `--k-text-md` | `12px` — table/body default |
| `--k-text-base` | `var(--vscode-font-size, 13px)` — page body |
| `--k-text-lg` | `14px` — section headings |
| `--k-text-xl` | `17px` — page title |
| `--k-text-2xl` | `20px` — stat numerals |
| `--k-weight-normal` / `-medium` / `-semibold` | `400` / `500` / `600` |
| `--k-leading-tight` / `-normal` | `1.15` / `1.45` |

Nine steps replace ~30 ad-hoc sizes. `9px`, `9.5px`, `10.5px`, `12.5px` are
**removed**, not tokenized — they were rounding noise, not intent.

### 2.5 Elevation

| Token | Value | Use |
|---|---|---|
| `--k-elev-0` | `none` | flush |
| `--k-elev-1` | `0 1px 2px rgba(0,0,0,.18)` | raised row, popover |
| `--k-elev-2` | `0 4px 12px rgba(0,0,0,.28)` | drawer, dropdown |
| `--k-elev-3` | `0 8px 28px rgba(0,0,0,.35)` | modal, toast |
| `--k-scrim` | `rgba(0,0,0,.35)` | modal/drawer backdrop |

### 2.6 Motion

| Token | Value | Use |
|---|---|---|
| `--k-dur-fast` | `120ms` | hover, focus, color change |
| `--k-dur-base` | `180ms` | expand/collapse, small move |
| `--k-dur-slow` | `280ms` | drawer, modal |
| `--k-dur-spin` | `900ms` | one spinner revolution |
| `--k-dur-flash-copy` | `1200ms` | optimistic copy confirmation |
| `--k-dur-flash-done` | `2400ms` | terminal success badge dwell |
| `--k-ease-standard` | `cubic-bezier(.2,0,.2,1)` | default |
| `--k-ease-out` | `cubic-bezier(0,0,.2,1)` | entrances |

**Every** animation and transition must be nulled under
`@media (prefers-reduced-motion: reduce)`. The design system emits that block
once; a component must not reintroduce unguarded motion.

### 2.7 Sizing

| Token | Value | Use |
|---|---|---|
| `--k-border-w` | `1px` | hairline |
| `--k-control-h-sm` | `22px` | dense icon button |
| `--k-control-h-md` | `26px` | default control |
| `--k-control-h-lg` | `30px` | prominent control, node |
| `--k-hit-min` | `24px` | minimum pointer target (WCAG 2.2 §2.5.8 AA) |
| `--k-focus-w` | `1px` | focus ring width |
| `--k-focus-offset` | `1px` | focus ring offset |

### 2.8 Layering

| Token | Value |
|---|---|
| `--k-z-scrim` | `30` |
| `--k-z-drawer` | `40` |
| `--k-z-modal` | `50` |
| `--k-z-toast` | `60` |
| `--k-z-tooltip` | `70` |

---

## 3. The state matrix

Every interactive primitive must express these eight states. A primitive's row in
its own section below says *how*; this table says what each state **means** and
what it is **not allowed** to be confused with.

| State | Trigger | Required expression | Never |
|---|---|---|---|
| **default** | resting | the primitive's base look | — |
| **hover** | pointer over | `--k-surface-hover` wash or the variant's hover fill | a size change that reflows neighbours |
| **focus-visible** | keyboard focus | `outline: var(--k-focus-w) solid var(--k-focus)` at `--k-focus-offset` | removed, or replaced by a colour change alone |
| **active/pressed** | pointer down | a visible depress (scale `.96` or a darker fill) | nothing |
| **loading/processing** | async action in flight | `aria-busy="true"` + spinner **and** the control is non-re-triggerable | a label swap alone; a spinner without `aria-busy` |
| **disabled** | unavailable | `disabled` attribute, `--k-text-faint`, `opacity:.45`, `cursor:default` | `pointer-events:none` alone (kills the tooltip that explains *why*) |
| **error** | action failed / invalid input | `--k-danger` border or text, and a message a human can act on | a red control with no message |
| **success** | action succeeded | `--k-success` flash for `--k-dur-flash-done`, then return to default | a permanent green state that hides the next default |

Two states are distinct and must not be collapsed:

- **disabled** = "you cannot do this" (and the tooltip says why).
- **loading** = "you already did this, wait".

A control that is disabled *because* it is loading carries `aria-busy="true"`;
a control disabled for any other reason must not.

> **Scope.** These states apply to the interactive element itself (a `<button>`,
> `<a>`, or a primitive like `.k-btn`), never to a non-interactive container
> wrapping it. `:active` on a row `<div>` is a defect (UI-R09b) — a row does not
> post a message, so a press depress on it promises an interaction that does not
> exist.

---

## 4. Primitives

Class prefix is `k-`. A primitive owns its states; a screen supplies only content
and variant.

### 4.1 Button — `.k-btn`

The default interactive control. Always a real `<button>`.

**Variants** (`.k-btn--<variant>`)

| Variant | Look | Use |
|---|---|---|
| `primary` | filled `--k-action-bg` / `--k-action-fg` | the one main action of a view |
| `secondary` | `--k-action-2-bg` / `--k-action-2-fg`, `--k-border` hairline | everything alongside a primary |
| `ghost` | transparent, `--k-text-dim`, hairline border | tertiary / dismissive |
| `danger` | `--k-danger` border + text; filled `--k-danger` on hover | irreversible (merge, delete, archive) |
| `link` | no chrome, `--k-link`, underline on hover | navigation rendered as a button |

**Modifier** — `.k-btn--row`, composed *with* a variant, never instead of one
(`k-btn k-btn--ghost k-btn--row`). It marks a control that is a **row in a
list**: full width, left-aligned, and its success state is the selection wash
(`--k-surface-selected`) rather than the check glyph + `--k-success` border.

A row is not button-shaped — it is full width, usually its own grid, and its
content is the data. The badge was auto-placed into that grid: on a diff file
row it landed beside the status letter, reading `M ✓`, and pushed the path onto
a second line; on a sidebar ticket row it shifted the glyph, name and stage pill
sideways. Both then sat inside a green box. Success still has to be visible
(UI-R13), but for these rows the action is a handoff — an editor or a panel
opens — so the flash only has to say *which* row, which is what a selection wash
already means.

> `.ghost` currently exists in `ticketForm/webview.html` as a class with **no CSS
> rule at all** — `#attachBtn.ghost` renders as a primary button. `.k-btn--ghost`
> is the real thing.

**Sizes** (`.k-btn--sm` / default / `.k-btn--lg`) → heights `--k-control-h-sm` /
`-md` / `-lg`, padding from the space scale, font `--k-text-xs` / `-xs` / `-md`.

**State matrix**

| State | Expression |
|---|---|
| default | variant fill, `--k-radius-sm` |
| hover | variant hover fill; `--k-dur-fast` |
| focus-visible | `outline: var(--k-focus-w) solid var(--k-focus); outline-offset: var(--k-focus-offset)` |
| active | `transform: scale(.96)` |
| loading | `aria-busy="true"`, `disabled`, leading `.k-spinner` replaces any leading icon, label unchanged |
| disabled | `disabled`, `opacity:.45`, `cursor:default`, label unchanged |
| error | returns to default; the failure is reported by a toast or inline message, **not** by recolouring the button |
| success | `.k-btn.is-success` for `--k-dur-flash-done` — check glyph + `--k-success` — then default; on `.k-btn--row`, the `--k-surface-selected` wash instead |

The label **must not change** between default and loading. "Save" stays "Save";
the spinner carries the pending meaning. A label swap (`Save` → `Saving…`) moves
the control's accessible name mid-action and reflows its width.

### 4.2 Icon button — `.k-iconbtn`

Icon-only. Square, `--k-control-h-sm` or `-md`, never below `--k-hit-min`.

Same variants and state matrix as `.k-btn`, plus two hard requirements:

- an `aria-label` — the *accessible name*, since there is no text;
- a `title` with the **same text** — the *tooltip*, since the glyph is not
  self-evident.

In the loading state the icon is replaced by `.k-spinner`, never overlaid.

### 4.3 Link — `.k-link`

A real `<a>` for navigation, `--k-link`, underline on hover, same focus ring.
An `<a>` that triggers an action rather than navigating is a bug — use
`.k-btn--link`.

### 4.4 Input / textarea / select — `.k-input`

| State | Expression |
|---|---|
| default | `--k-surface`, `--k-border`, `--k-radius-sm`, `--k-text-md` |
| hover | `--k-border-strong` |
| focus-visible | focus ring (inputs get it on `:focus`, not only `:focus-visible`) |
| loading | `aria-busy="true"` + `readonly`; the field keeps its value |
| disabled | `disabled`, `--k-text-faint` |
| error | `aria-invalid="true"`, `--k-danger` border, message wired by `aria-describedby` |
| success | no persistent success styling — a valid field is simply default |

### 4.5 Form field — `.k-field`

Label + control + help/error, as one unit.

- The label is a real `<label for>`. A placeholder is **not** a label.
- The error message element's `id` is referenced by the control's
  `aria-describedby`, and the control carries `aria-invalid="true"` while it is
  in error.
- One error message may serve one field. A single page-level error bucket that
  every failure funnels into (today's `#err` in the ticket form, `#errBanner` in
  settings) is permitted only for failures that belong to no single field.

### 4.6 Switch — `.k-switch`

Two-state on/off. `role="switch"` + `aria-checked`, keyboard-operable with
<kbd>Space</kbd> and <kbd>Enter</kbd>. Track `--k-radius-pill`, thumb
`--k-radius-circle`, transition `--k-dur-fast`.

A toggle *button* (pressed/unpressed) uses `.k-btn` + `aria-pressed` instead.
Pick by meaning: `aria-pressed` = "this button is currently engaged";
`role="switch"` = "this setting is on".

### 4.7 Chip — `.k-chip`

Compact selectable or informational token. `--k-radius-pill`.

- Selectable → real `<button>` + `aria-pressed`.
- Single-select group → `role="radio"` inside `role="radiogroup"` + `aria-checked`.
- Informational only → a `<span>` with **no** `tabindex` and **no** `role="button"`.

This replaces the six divergent pill shapes (`keypill`, `fixtoggle`, `approach .aid`,
`pr .pst`, repo `chip`, `delta`) with one shape at one radius.

### 4.8 Status dot — `.k-dot`

Non-interactive. `--k-radius-circle`, colour strictly from the status ramp
(`--k-pending|running|attention|passed|failed`), `role="img"` with an `aria-label`
naming the status in words. Colour is never the only carrier of meaning.

### 4.9 Spinner — `.k-spinner`

The one pending indicator. Ring, `--k-dur-spin` linear infinite, `currentColor`,
sized to the control. `aria-hidden="true"` — the busy meaning is carried by the
host control's `aria-busy`, not by the spinner element.

Nulled under `prefers-reduced-motion`, where a static ring is shown instead. The
pending state is still conveyed, because `aria-busy` and the disabled control do
not depend on motion.

### 4.10 Modal — `.k-modal`

`role="dialog"` + `aria-modal="true"` + `aria-labelledby`. Scrim `--k-scrim` at
`--k-z-scrim`, panel `--k-elev-3` / `--k-radius-xl` at `--k-z-modal`.

Required behaviour: focus moves into the dialog on open, is **trapped** while
open, and returns to the invoking control on close; <kbd>Esc</kbd> closes; the
scrim closes only non-destructive dialogs.

A confirmation for an irreversible action is a **host-side** VS Code modal, not a
webview one — a crafted webview message must not be able to skip it. (This is
already the rule for `merge-pr`.)

### 4.11 Drawer — `.k-drawer`

Side panel. Same dialog semantics as `.k-modal` at `--k-z-drawer` / `--k-elev-2`,
`--k-dur-slow`. The invoking control carries `aria-expanded`.

### 4.12 Toast — `.k-toast`

The terminal result of an async action that has no inline home.

- Container is a single `<div role="status" aria-live="polite">` at `--k-z-toast`.
- Variants `--success` / `--error` / `--info`, from the feedback tokens.
- Success auto-dismisses after `--k-dur-flash-done`; **error does not
  auto-dismiss** and carries a close button.
- Never the *only* record of a destructive failure — that also belongs inline.

### 4.13 Tooltip — `.k-tooltip`

Short explanatory text on a control whose purpose is not self-evident.

Implemented as the native `title` attribute. That is deliberate: `title` is
keyboard-reachable through the platform, survives the CSP with no JS, and needs
no positioning logic. A custom tooltip may only be introduced if it also works on
focus, not only hover.

- **Max 80 characters**, one sentence, no trailing period.
- States what the control *does*, not what it is ("Re-probe every PR", not
  "Refresh button").
- On an icon-only control the `title` and the `aria-label` are the **same string**.

### 4.14 Empty state — `.k-empty`

Dashed `--k-border`, `--k-radius-xl`, centered. A headline naming what is absent
and a hint naming the next action. **Never** a grid of zeros: "0" asserts a
measurement, absence does not.

---

## 5. Async interaction contract

This is the part the UI has none of today (`aria-busy` count: **0**).

### 5.1 Vocabulary

An **async action** is any control that posts a message to the host. Two kinds:

| Kind | Definition | Settles on |
|---|---|---|
| `handoff` | the host hands the request to VS Code and the result is visible outside the webview (open a terminal, reveal a folder, open a URL, open an editor) | the host's **ack** |
| `mutating` | the host changes state the webview renders (ship, merge, archive, save, spin, delete, set-*) | the host's **result**, or the next `state` push |

### 5.2 Required lifecycle

```
idle ──click──▶ pending ──result:ok───▶ success flash ──▶ idle
                   │     └─result:err──▶ error surfaced ──▶ idle
                   └─────timeout───────▶ error surfaced ──▶ idle
```

1. **On click** the control enters pending: `aria-busy="true"`, `disabled`,
   `.k-spinner`. This happens immediately and locally — it must not wait for a
   round trip, because the round trip is exactly what is being reported.
2. **While pending** the control is non-re-triggerable. The runtime keys pending
   state by control identity, so a second click is dropped, not queued.
3. **On terminal result** the control leaves pending and the outcome is surfaced:
   success as a flash (or simply the new state, if the state push itself is the
   visible answer), failure as a toast or inline message that names what failed.
4. **A watchdog is mandatory.** A control may never be permanently stuck
   pending. On timeout the control leaves pending and reports that the result is
   unknown — which is honest, and is not the same as reporting failure.

### 5.3 Re-rendered screens: bind the pieces, not the element

`karstAction(el, send)` attaches a listener to **one element**. Most Karst
screens re-render by replacing `innerHTML` and dispatch clicks from a single
delegated document listener, so a per-element binding is destroyed on the next
repaint and the control silently loses its feedback.

On those screens, drive the lifecycle from the delegated handler using the same
pieces `karstAction` uses internally:

```js
const el = ev.target.closest('[data-act]');
if (!el || karstIsPending(el)) return;          // dropped, not queued
const requestId = karstRequestId();
karstBeginPending(el, requestId);                // aria-busy + disabled + spinner + watchdog
post({ type: el.dataset.act, repo: el.dataset.repo, requestId });
```

`karstSettle` then resolves it from the `action-result` handler exactly as
before. This is not a workaround — it is the supported shape for a delegated
screen, and `sidebar`, `diffs` and `dashboard` all use it.

A control whose settlement is genuinely just "the next `state` push" (a filter, a
facet toggle) may stay immediate and carry no `requestId`. That is a deliberate
exemption, not an oversight, and it should be commented as one.

### 5.4 Host contract

The webview→host message carries a `requestId`. The host replies once:

```ts
{ type: 'action-result', requestId: string, ok: boolean, message?: string }
```

`message` is untrusted prose (it can be CLI or model output), so it is collapsed
to one line and length-capped before it reaches a toast — the same rule
`agent/cliFailure.ts` already applies to verdicts and logs.

Because every webview dispatches through a single `routeAction`-shaped seam, the
ack is emitted at that **one** seam per webview, not at ~90 call sites. Action
methods widen from `() => void` to `() => void | Promise<void>`; the dispatcher
awaits a returned thenable and reports the real outcome, and acks on the spot
when nothing is returned. Widening a return type is not a behaviour change: every
existing implementation still satisfies it, and one that keeps returning `void`
keeps its current semantics exactly.

### 5.5 Optimistic feedback

Permitted only where the host cannot fail in a way the user needs to know about,
and it must be labelled as optimistic in a comment. Today's `flashCopied()` is
the only legitimate case (a clipboard write). It is **not** legitimate for a
merge, a save, or a delete.

---

## 6. Accessibility baseline

Non-negotiable, and checkable:

1. **Visible focus.** Every focusable element shows the `--k-focus` ring. `outline: none`
   without a replacement ring is banned.
2. **Contrast.** Text meets WCAG 2.1 AA — 4.5:1 body, 3:1 for ≥ `--k-text-lg`
   semibold and for UI component boundaries. Because colours resolve to the
   user's theme, contrast is guaranteed by *using the paired tokens*
   (`--k-action-fg` on `--k-action-bg`, `--k-danger-fg` on `--k-danger`) and
   never by hand-picking a foreground.
3. **Accessible names.** Every icon-only control has an `aria-label`. Every form
   control has a `<label for>`.
4. **ARIA state.** `aria-busy` while pending; `aria-disabled` is not a substitute
   for `disabled`; `aria-expanded` on every disclosure trigger; `aria-pressed` on
   toggle buttons; `aria-checked` on `role="switch"`/`role="radio"`;
   `aria-invalid` + `aria-describedby` on a field in error; `aria-current` on the
   active step of a wizard.
5. **Keyboard operability.** Every action is reachable and operable by keyboard.
   A `<div>`/`<span>` with a click handler is a defect — use a `<button>`. Where a
   non-native control is unavoidable it needs `role`, `tabindex="0"`, and
   <kbd>Enter</kbd>+<kbd>Space</kbd> handlers.
6. **Announcements.** Anything that changes without user action — pending
   completion, a result, a progress step — is announced through a live region.
   One `role="status" aria-live="polite"` region per webview, supplied by
   `.k-toast`'s container.
7. **Colour is never alone.** Status is carried by a glyph or text as well as a
   hue.
8. **Motion.** `prefers-reduced-motion: reduce` nulls every animation; no
   information is lost when it does.

---

## 7. What this does not cover

- The **status ramp** (`--k-*`) and the **stage ramp** — owned by
  `src/model/palette.ts` and `src/model/stagePalette.ts`. Consumed here, never
  redefined.
- The **provider badge** — owned by `src/model/providerIdentity.ts`.
- **Host-side formatting** of any displayed value. A number, a duration, a path,
  or a verdict string is rendered host-side and arrives pre-formatted. A
  formatter in a webview is a second implementation of a rule that already
  exists.
