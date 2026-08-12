# Karst Design System

**Version:** 3.0 — finalized UI contract

The source of truth for Karst's shared visual language: **semantic tokens,
shared primitives, component states, and accessibility contracts**.

This document defines *what the UI is made of*.

[UI-RULES.md](./UI-RULES.md) defines the binding repository invariants.
[STYLE-GUIDE.md](./STYLE-GUIDE.md) defines how to apply this system while
preserving Karst's product character.
[ICONS.md](./ICONS.md) defines the icon standard (Tabler Icons, vendored and
delivered through the same marker injection as this system).

[KARST-UI-CATALOG.html](./KARST-UI-CATALOG.html) is the rendered catalog of the
primitives, states and tokens described here.

Parts of this contract are not yet what the repository ships — notably the
`.k-status` primitive (§11.12), the feedback-token aliasing rule (§2.2/§3.5), the
filled-surface foregrounds (§3.5) and the unified palette delivery (§1.2). Those
deltas are enumerated in
[V3-CONFORMANCE-GAPS.md](./V3-CONFORMANCE-GAPS.md); read this document as the
target, and that one for what is still open.

This document does **not** define host/webview transport, request IDs,
dispatching, persistence, retry policy, or domain behavior.

---

## 0. Product character

Karst is a dense developer tool inside VS Code.

The approved UI direction is:

- compact rather than spacious;
- structured rather than decorative;
- restrained in borders, fills, shadows, and animation;
- strongly hierarchical;
- explicit about stage and workflow status;
- native-feeling inside VS Code;
- context-aware rather than forcing every UI object into one generic component
  shape.

Consistency means **the same semantic thing behaves and renders consistently**.

Consistency does not mean:

- every row is a button;
- every label is a pill;
- every local composition is a card;
- every status uses the same generic feedback treatment;
- every dimension belongs to one global spacing scale.

The current prototype-approved density and visual tuning are the baseline.
Changing token values for spacing, type, radius, or sizing is a separate visual
design decision and must not happen as incidental cleanup.

---

# 1. Delivery

Karst currently ships self-contained `webview.html` documents and uses
host-side marker injection for shared UI assets.

This is a **repository architecture choice**, not a CSP requirement. VS Code
supports extension-local webview resources under an appropriate CSP; Karst keeps
marker injection because it fits the current build/runtime architecture and
avoids introducing another frontend delivery mechanism.

## 1.1 Required markers

Every webview carries:

- `<!--KARST_CSP-->`
- `/*KARST_DS_CSS*/`
- `/*KARST_DS_JS*/`

The host applies the shared design-system injection before the CSP nonce pass.
The `/*KARST_DS_*` markers also deliver the Tabler icon catalog and the
`karstIcon()` runtime (`.k-icon` treatment + `KARST_TABLER_ICONS` — see
[ICONS.md](./ICONS.md) §1), so every webview gets the icon vocabulary by
construction, exactly like tokens and the action runtime.

Webview discovery tests enumerate webview directories from disk. They must not
use a handwritten list.

## 1.2 Target: one shared visual delivery path

The status and stage palettes remain owned by:

- `src/model/palette.ts`
- `src/model/stagePalette.ts`

**Current implementation:** some webviews still receive these through the
separate `/*KARST_PALETTE*/` marker and `injectPalette(...)` path.

**Target implementation:** palette and stage-palette CSS are assembled into the
mandatory `injectDesignSystem(html)` delivery path.

A webview must not permanently need to opt into the token system and palette
system independently. That split previously allowed a semantic token to resolve
through a missing palette variable without any failure.

Once the target delivery path is implemented and covered by discovery tests,
`/*KARST_PALETTE*/` and redundant `injectPalette(...)` calls are removed.

Palette ownership remains separate in TypeScript; only delivery is unified.

## 1.3 Ownership

| Concern | Owner |
|---|---|
| visual tokens | `designTokens.ts` |
| shared primitive CSS | `designComponents.ts` |
| icon catalog + shared stroke treatment | `tablerIcons.ts` (see [ICONS.md](./ICONS.md)) |
| status visual source | `palette.ts` |
| stage palette | `stagePalette.ts` |
| shared UI/component behavior | shared webview runtime |
| agent-core icon + canonical name mapping | `src/model/providerIdentity.ts` |
| screen composition | `src/ui/<view>/webview.html` |
| host/domain behavior | host/application code |

Shared UI JavaScript may implement component behavior such as toast dismissal,
focus management, or common busy-state presentation.

The host action protocol is not part of the design system.

---

# 2. Token model

A token represents a **reusable visual decision**.

Tokens are required for:

- semantic colors;
- repeated typography roles;
- repeated spacing;
- shared radii;
- shared component sizes;
- elevation;
- motion;
- layering.

Tokens are not required for arbitrary CSS syntax or unique layout geometry.

Valid screen-local CSS may contain, for example:

```css
grid-template-columns: 172px minmax(0, 1fr);
transform: translateX(-50%);
clip-path: polygon(...);
width: 86vw;
```

when those values belong to that composition rather than the shared visual
system.

Do not replace a clear local dimension with meaningless arithmetic such as:

```css
width: calc(var(--k-space-8) * 23);
```

merely to satisfy a source-code rule.

If a local dimension becomes a repeated component contract, promote it to a
meaningful component token.

---

## 2.1 Semantic identity is not value identity

Two semantic tokens may intentionally have the same current value.

For example:

```text
workflow passed ─┐
                 ├─ may use the same current positive tone
feedback success ┘
```

They remain separate semantic roles.

Likewise:

```text
page background
sunken surface
```

may currently resolve to the same VS Code value without becoming the same token.

The system forbids **duplicate meanings**, not duplicate underlying values.

---

## 2.2 Semantic layers

Karst uses this model:

```text
theme / palette source
        ↓
semantic roles
        ↓
components / domain UI
```

A semantic CSS token must not alias through another unrelated semantic CSS token
just because the current color matches.

If two roles use the same actual color, their TypeScript definitions may source
the same **private/shared palette value in TypeScript**.

Do not introduce another public CSS namespace such as `--k-tone-positive` merely
to deduplicate values unless a real component needs to consume that foundation
role directly.

Example:

```text
positive palette source
 ├─ --k-passed
 └─ --k-success
```

not:

```text
--k-success: var(--k-passed)
```

This preserves one controlled visual source without making "success feedback"
mean "workflow passed".

---

# 3. Color

## 3.1 Surface

| Token | Current value | Use |
|---|---|---|
| `--k-bg` | `var(--vscode-editor-background)` | page background |
| `--k-surface` | `var(--vscode-editorWidget-background, var(--vscode-editor-background))` | panels, drawers, cards |
| `--k-surface-hover` | `var(--vscode-list-hoverBackground)` | hover wash |
| `--k-surface-selected` | `var(--vscode-list-inactiveSelectionBackground, var(--k-surface-hover))` | persistent selection |
| `--k-surface-sunken` | `var(--vscode-editor-background)` | wells, tracks |
| `--k-border` | theme-derived neutral border | normal hairline |
| `--k-border-strong` | theme contrast border | high-emphasis boundary |

`--k-bg` and `--k-surface-sunken` intentionally remain separate semantic names.

## 3.2 Text

| Token | Use |
|---|---|
| `--k-text` | body / primary |
| `--k-text-dim` | secondary labels and metadata |
| `--k-text-faint` | tertiary/unavailable |
| `--k-link` | navigation |
| `--k-link-active` | navigation hover/active |

## 3.3 Actions

| Token | Use |
|---|---|
| `--k-action-bg` | primary action background |
| `--k-action-fg` | primary action foreground |
| `--k-action-bg-hover` | primary hover |
| `--k-action-2-bg` | secondary action background |
| `--k-action-2-fg` | secondary action foreground |
| `--k-action-2-bg-hover` | secondary hover |
| `--k-focus` | shared focus indicator |

Where VS Code exposes a paired control foreground/background role, use the pair.

---

## 3.4 Workflow status

Owned visually by `palette.ts`.

| Token | Meaning |
|---|---|
| `--k-pending` | not started / not checked / neutral waiting |
| `--k-running` | actively in progress |
| `--k-attention` | paused / blocked / waiting for intervention |
| `--k-passed` | passed / done / completed |
| `--k-failed` | terminal failure |

Workflow status is rendered by the icon-only `.k-status` primitive (§11.12).
The glyph/shape carries the visible state; color reinforces it.

`offline`, `skipped`, and other domain states remain explicit domain meanings.
They may intentionally use the same neutral visual treatment as another state
when surrounding copy supplies the distinction, but must not be renamed merely
to obtain a color.

---

## 3.5 Feedback

Feedback describes the UI's communication tone.

| Token | Meaning |
|---|---|
| `--k-success` | positive result |
| `--k-warning` | warning / caution |
| `--k-danger` | error / destructive emphasis |
| `--k-info` | neutral information |
| `--k-success-fg` | foreground on filled success |
| `--k-danger-fg` | foreground on filled danger |

Feedback tokens and workflow-status tokens may source the same palette constants,
but they do not alias each other in CSS.

**Current intended mapping:** `--k-passed` and `--k-success` use the same positive
palette value and therefore render as the same green. That is intentional.
`passed` means workflow state; `success` means generic UI feedback. Their semantic
names remain separate so either role can diverge later without changing usage.

The same principle may apply to other status/feedback pairs: shared visual source,
separate semantic token.

Filled semantic surfaces require an explicitly tested foreground pair.

`--k-success-fg` / `--k-danger-fg` must not simply be the page background.
Their concrete theme values are owned alongside the palette and are pinned by
contrast tests.

---

## 3.6 Data series

Categorical visualization colors are independent semantic roles.

| Token | Meaning |
|---|---|
| `--k-series-1` | first categorical series |
| `--k-series-2` | second categorical series |

To preserve the current approved visual appearance, a series token may currently
use the same actual hue as another palette source.

It must still be emitted independently.

Never use:

- `--k-running` as a chart series;
- `--k-info` as a chart series;
- `--k-series-2` as a merged/status badge;
- chart-series colors to communicate workflow meaning.

---

## 3.7 Stages

Stage identity is owned by `stagePalette.ts`.

Karst's primary workflow is:

```text
Scope → Implement → UAT → Review → Ship → Done
```

Stage identity is not generic feedback.

A stage must not become "success", "warning", or "info" merely because those
colors are visually convenient.

---

# 4. Spacing

The current spacing scale is preserved:

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

Use this scale for recurring:

- margin;
- padding;
- gap;
- compact rhythm.

The scale is **not** a universal dimension scale.

A graph node, drawer width, column width, timeline offset, or other
composition-specific geometry may use a local value.

`1px` hairlines use `--k-border-w`.

Do not expand this scale merely to absorb every historical literal.

---

# 5. Radius

Current visual values are preserved.

| Token | Value | Use |
|---|---|---|
| `--k-radius-xs` | `3px` | tiny overlay/detail controls |
| `--k-radius-sm` | `5px` | buttons, inputs |
| `--k-radius-md` | `6px` | rows, compact surfaces |
| `--k-radius-lg` | `9px` | badges/pills |
| `--k-radius-xl` | `12px` | large overlays |
| `--k-radius-pill` | `999px` | pill geometry |
| `--k-radius-circle` | `50%` | circles |

A local non-shared shape may use local geometry.

---

# 6. Typography

The current visual sizing is preserved in this remediation.

Names describe roles where possible; no new size is introduced merely for
taxonomy.

| Token | Current value | Role |
|---|---|---|
| `--k-text-2xs` | `10px` | dense metadata |
| `--k-text-xs` | `11px` | captions / compact control labels |
| `--k-text-sm` | `11.5px` | secondary body |
| `--k-text-md` | `12px` | dense table/body |
| `--k-text-base` | current 13px/body contract | normal page body |
| `--k-text-lg` | `14px` | section heading |
| `--k-text-xl` | `17px` | page/view title |
| `--k-text-2xl` | `20px` | prominent statistic |

The existing `11.5px` value is preserved because changing it would be a visual
retuning. Whether the scale should later be simplified is a separate design
decision.

Weights:

- `--k-weight-normal`: `400`
- `--k-weight-medium`: `500`
- `--k-weight-semibold`: `600`

Leading:

- `--k-leading-tight`: `1.15`
- `--k-leading-normal`: `1.45`

Do not create further fractional sizes to preserve incidental historical
differences.

### Font family

Do not switch the Karst UI to VS Code's **editor** font merely because webviews
expose `--vscode-editor-font-family`; preserve the current approved Karst UI font
behavior until a dedicated typography change verifies the visual result.

---

# 7. Elevation

Keep only shared elevation levels that are actually used.

| Token | Use |
|---|---|
| `--k-elev-2` | drawer/dropdown |
| `--k-elev-3` | modal/toast |
| `--k-scrim` | modal backdrop |

Unused theoretical elevation levels should not exist solely to complete a scale.

Concrete values remain the current implementation values unless changed by a
visual-design task.

---

# 8. Motion

Shared motion tokens remain:

| Token | Use |
|---|---|
| `--k-dur-fast` | hover/focus/color |
| `--k-dur-base` | small expansion/move |
| `--k-dur-slow` | overlay entrance |
| `--k-dur-spin` | spinner |
| `--k-dur-flash-copy` | copy acknowledgement |
| `--k-dur-flash-done` | transient completion acknowledgement |
| `--k-ease-standard` | default easing |
| `--k-ease-out` | entrances |

Reduced-motion mode removes non-essential animation without removing state.

Meaning must survive when animation stops.

---

# 9. Shared sizing

Current compact density is preserved:

| Token | Value | Use |
|---|---|---|
| `--k-border-w` | `1px` | hairline |
| `--k-control-h-sm` | `22px` | dense text control |
| `--k-control-h-md` | `26px` | default control |
| `--k-control-h-lg` | `30px` | prominent control |
| `--k-hit-min` | `24px` | preferred standalone pointer target |
| `--k-focus-w` | current shared value | focus indicator |
| `--k-focus-offset` | current shared value | focus offset |

A `22px` dense text control is not automatically invalid. Karst nevertheless
requires standalone icon buttons to provide at least a `24×24px` target.

Do not misrepresent `--k-hit-min` as an exceptionless WCAG rule.

---

# 10. Component-state vocabulary

The shared state vocabulary is:

- default;
- hover;
- focus-visible;
- active;
- loading;
- disabled;
- error;
- success;
- selected;
- checked;
- expanded.

Not every component supports every state.

Each primitive declares applicable states. Unsupported states are `N/A`, not
features that must be invented.

---

# 11. Primitives

## 11.1 Button — `.k-btn`

A real `<button>` used for actions.

### Variants

| Variant | Meaning |
|---|---|
| `primary` | main action in the current context |
| `secondary` | ordinary adjacent action |
| `ghost` | low-emphasis action |
| `danger` | destructive action |
| `text` | action with minimal visual chrome |

`text` replaces the ambiguous term "link button".

Navigation uses `.k-link` on `<a href>`.

### Sizes

Current shared heights remain:

- `.k-btn--sm` → `--k-control-h-sm`
- default → `--k-control-h-md`
- `.k-btn--lg` → `--k-control-h-lg`

Buttons use:

- shared button typography;
- `--k-radius-sm`;
- shared variant border/fill;
- spacing tokens for shared internal padding.

A local screen may position or constrain a button but may not recreate another
button appearance locally.

### States

| State | Contract |
|---|---|
| default | variant appearance |
| hover | shared variant hover |
| focus-visible | visible `--k-focus` treatment |
| active | subtle press feedback; no neighboring reflow |
| loading | when the action genuinely waits; exposes busy state |
| disabled | unavailable state |
| error | normally surfaced at owning context, not by permanently recoloring button |
| success | optional transient acknowledgement when changed state is not already obvious |
| selected | only for explicitly selectable button patterns |

Pending/success affordances must not cause disruptive width changes. Reserve a
status/icon slot, preserve minimum width, or put the status adjacent where needed.

Changing the label during pending is not globally forbidden, but unnecessary
accessible-name churn and layout shifts should be avoided.

---

## 11.2 Icon button — `.k-iconbtn`

A real button whose visible content is only a glyph/icon.

Requirements:

- accessible name;
- shared icon-button appearance;
- minimum `24×24px` standalone target;
- decorative icon hidden from assistive technology when the button itself is
  already named.

A matching `title` may be added as supplemental pointer help.

`title` is not the accessible name.

---

## 11.3 Link — `.k-link`

A real `<a href>` used for navigation or resource reveal.

When a file path, PR number, commit hash, URL, or other resource identifier is
already visible, the identifier itself is the link.

Example:

```html
<a class="k-link mono" href="…">src/store/recoveryRounds.ts:693</a>
```

Do not render the path as inert text plus an adjacent **Open file** button when
both perform the same navigation.

If VS Code/host mediation is required to reveal a resource, the webview may route
the link activation through the host, but the UI remains link semantics rather
than a visually separate action button.

An action that merely looks link-like remains a `<button class="k-btn
k-btn--text">`.

---

## 11.4 Input — `.k-input`

For text-like input and textarea controls.

Applicable states:

- default;
- hover;
- focus;
- readonly;
- disabled;
- error;
- busy where editing genuinely needs to be suspended.

Field errors use:

- `aria-invalid="true"`;
- an actionable message;
- programmatic association with that message.

---

## 11.5 Select — `.k-select`

Native `<select>` is a separate primitive from text input.

A `<select>` has no `readonly` state.

When unavailable, use a real supported state such as `disabled`.

When its options are asynchronously loading, expose that state at the owning
field/surface instead of inventing a readonly-select contract.

---

## 11.6 Field — `.k-field`

Label + control + help/error.

Prefer native `<label for>`.

Field-specific errors stay with the field.

A global/page error region is for errors without a meaningful local owner.

---

## 11.7 Switch — `.k-switch`

Used for a persistent on/off setting.

Prefer a native checkbox with switch styling where practical.

If a custom switch is necessary, it implements the full switch semantics and
keyboard contract.

A temporary pressed/unpressed action is a button with `aria-pressed`, not a
switch.

---

## 11.8 Badge — `.k-badge`

Non-interactive compact information.

Examples:

- stage;
- repository state;
- count;
- usage total;
- draft / merged metadata.

An agent core/provider identity is **not** a badge. Use `.k-agent-core`
(§11.9).

An informational badge does not gain pressed/hover/disabled semantics simply
because an interactive chip exists elsewhere.

---

## 11.9 Agent core identity — `.k-agent-core`

Whenever an agent core is shown, its identity is:

**canonical core icon + canonical core name**

The mapping is owned by `src/model/providerIdentity.ts`.

Examples of core names include:

- Claude Code
- Codex
- AGY
- OpenCode

The icon is decorative when the visible name is present.

Optional secondary metadata may follow the core identity when it helps explain
the configured or recorded run:

```text
<core icon> Claude Code · Opus 5
<core icon> Codex · GPT-5.6 · high
<core icon> OpenCode · mimo-v2.5-free
```

Display order is:

1. agent role, when the row needs one (`Review Agent`, `UAT Agent`, `PR Agent`);
2. core icon + core name;
3. model, when useful;
4. effort or variant, when useful;
5. usage/timing as separate metadata.

The core name is mandatory whenever the core is displayed. Never show:

- a core icon without its name;
- a model name as a replacement for the core;
- a generic `AI` badge as the agent identity;
- a text-only core name when the shared identity renderer is available.

Model / effort / variant are secondary metadata, not part of the canonical core
name.

### Agent-core selectors

A selector that presents agent cores must preserve the same icon + canonical-name
identity for every choice.

A plain native `<select>` is not appropriate when it reduces agent choices to
text-only core names. Prefer the single-select choice/radio pattern (§11.11), or
another accessible selector that can render the shared `.k-agent-core` identity.

The selector's interaction semantics remain those of a single choice; the
identity requirement does not justify an incomplete custom listbox.

---

## 11.10 Toggle chip — `.k-chip`

Interactive compact binary choice.

Use a real `<button aria-pressed>`.

Applicable states:

- default;
- hover;
- focus;
- active;
- pressed;
- disabled.

Do not use `.k-chip` for purely informational content.

---

## 11.11 Single-select choice

Prefer native radio controls.

If a custom radio visual is required, implement the complete radio interaction
model, including keyboard focus and arrow-key navigation—not only
`role="radio"` and `aria-checked`.

---

## 11.12 Workflow status — `.k-status`

A non-interactive, **icon-only** workflow-state marker.

The primitive does not render a visible status word. Surrounding process copy may
describe the result where useful, but the marker itself is only the icon.

| State | Visible marker | Color |
|---|---|---|
| pending / not checked | neutral circle/dot | `--k-pending` |
| running | spinner | `--k-running` |
| needs attention / paused / blocked | pause icon | `--k-attention` |
| passed / done | checkmark | `--k-passed` |
| failed | cross | `--k-failed` |

`passed` and `done` intentionally share the same visible green checkmark.

Requirements:

- each state has a distinct glyph/shape, so hue is not the only visible carrier;
- the marker has an accessible name such as `aria-label="Passed"` or
  `aria-label="Needs attention"`;
- the accessible name uses the actual domain wording even when two domain states
  share one visual marker;
- the marker is non-interactive unless the surrounding product composition gives
  it a separate explicit action.

Example:

```html
<span class="k-status k-status--passed" role="img" aria-label="Done">✓</span>
```

No visible `Passed`, `Done`, `Running`, or `Needs attention` text is appended by
the status primitive itself.

---

## 11.13 Spinner — `.k-spinner`

The shared visual pending indicator.

The spinner is decorative when busy state is already exposed by its owner.

The running `.k-status` variant may use this spinner inside an accessible
icon-only status container.

Reduced motion stops the animation but leaves a static pending indicator.

---

## 11.14 Modal — `.k-modal`

A modal dialog:

- has an accessible name;
- moves focus inside when opened;
- contains focus while modal;
- supports expected dismissal behavior;
- restores focus to an appropriate location after close.

Irreversible operations whose confirmation must not be bypassable remain
confirmed host-side.

---

## 11.15 Modal drawer — `.k-drawer`

An overlay side surface that makes the underlying interface temporarily
unavailable.

It follows modal-dialog semantics.

---

## 11.16 Side panel / inspector — `.k-panel`

A non-modal contextual side surface.

It does not:

- claim `aria-modal`;
- trap focus;
- prevent interaction with the underlying screen.

Use it for details/inspection flows where users should move between the panel
and main content.

---

## 11.17 Toast — `.k-toast`

Transient result communication where no stronger inline home exists.

One coordinated polite live region per webview is the default for ordinary
transient results.

Variants:

- success;
- error;
- info.

A persistent error toast includes a real dismiss button.

An error that belongs to a field, modal, drawer, or workflow remains recorded
there rather than existing only as a toast.

---

## 11.18 Tooltip / contextual help

Native `title` is supplemental convenience only.

Required information must not depend on it.

If a disabled control needs an explanation, use visible or programmatically
associated help.

A custom tooltip that conveys useful information must work for keyboard focus as
well as pointer hover.

---

## 11.19 Empty state — `.k-empty`

State:

1. what is absent;
2. what causes it to appear or what the user can do next.

Do not use a grid of zeros as a synonym for no data.

---

# 12. Accessibility baseline

## 12.1 Native semantics

Prefer native HTML.

Use ARIA to expose real component state, not to compensate for incorrect element
semantics.

## 12.2 Focus

Every keyboard-focusable interactive element has a clearly visible focus
indicator.

Non-rectangular controls may use a shape-aware focus treatment rather than a
rectangular outline when needed.

## 12.3 Contrast

Normal text meets at least `4.5:1`.

The lower `3:1` text threshold applies only to text that actually qualifies as
large text under WCAG; a Karst `14px` heading does not qualify merely because it
is called `lg`.

Required UI boundaries/state indicators meet applicable non-text contrast
requirements.

Verify:

- light;
- dark;
- high-contrast

theme behavior.

Shared primitives and reusable local patterns must derive surfaces, text,
borders, and state fills from semantic/theme tokens rather than hard-coded
dark-theme literals. A component that looks correct only in the default dark
theme is not conformant.

## 12.4 Names

- icon-only controls have accessible names;
- form controls have programmatic labels;
- decorative SVGs are hidden where appropriate;
- status glyphs either have full accessible text or are decorative beside it.

## 12.5 Color

Color is never the only **visible** carrier of meaningful state.

For workflow status, the distinct status glyph (check / spinner / pause / cross /
neutral marker) is the non-color carrier. A visible status word is not required.

An `aria-label` does not solve color-only information for a sighted user; it
supplies the accessible name for the icon-only status marker.

## 12.6 Disabled controls

Use native `disabled` when removing the control from ordinary keyboard
interaction is appropriate.

Use `aria-disabled` only where keeping the unavailable control discoverable is
intentional and activation is correctly prevented.

## 12.7 Motion

Reduced motion removes non-essential animation without removing information.

---

# 13. Host / webview boundary

The host owns:

- domain state;
- permissions;
- persistence;
- external command/provider results;
- consequential operations;
- security-sensitive confirmation;
- canonical business rules.

The webview owns:

- composition;
- component selection;
- classes;
- glyphs;
- semantic visual tokens;
- purely presentational formatting.

Prefer:

```ts
{ status: 'failed', stage: 'review', canMerge: false }
```

over:

```ts
{ className: 'red-pill', color: '#f14c4c', icon: 'x' }
```

## 13.1 Formatting boundary

Canonical/domain formatting remains upstream when it carries meaning.

Examples:

- verdict classification;
- stage labels;
- provider-defined meaning;
- domain-specific duration interpretation.

Pure display formatting may live in the presentation layer when it does not
reimplement a business rule.

Examples:

- visual truncation;
- localized numeric separators;
- compact display formatting.

---

## 13.2 Agent identity boundary

Domain/application code may supply semantic agent metadata such as:

```ts
{
  agentCore: 'claude-code',
  model: 'opus-5',
  effort: 'high'
}
```

The shared provider identity mapping resolves the core identifier to its canonical
icon and visible name. Host/domain code does not hand-pick an icon glyph, provider
color, or CSS class.

Model, effort, and variant remain semantic metadata and are rendered only where
they add useful run/configuration context.

---

# 14. Out of scope

The design system does not define:

- request IDs;
- `action-result` wire shape;
- dispatcher seams;
- retry/idempotency;
- watchdog duration;
- persistence;
- host command implementation;
- domain workflow transitions.

The UI contract may require observable behavior such as immediate pending
feedback or safe duplicate prevention, but the transport implementation belongs
to application architecture.
