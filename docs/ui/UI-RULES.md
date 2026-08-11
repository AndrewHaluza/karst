# Karst UI Rules

**Version:** 3.0 — finalized normative rules

Binding rules for agents and humans modifying Karst UI.

These rules apply to files under `src/ui/`, shared webview UI modules, and
`webview.html`.

[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) defines visual primitives and tokens.
[STYLE-GUIDE.md](./STYLE-GUIDE.md) provides application/design guidance.

Repository architecture invariants in `CLAUDE.md` / `AGENTS.md` take precedence.
A conflict is reported rather than worked around.

---

# Verification modes

Every rule declares how it can actually be verified.

### STATIC

Source structure or emitted source can prove the rule.

### RUNTIME

A unit, fake-DOM, integration, or protocol test is required.

### VISUAL

A real VS Code/webview review is required because source inspection cannot prove
the rendered property.

### REVIEW

A semantic/design/architecture judgment is required where correctness depends on
meaning rather than source shape, runtime behavior, or rendered pixels. Examples
include deciding whether two tokens represent the same semantic role or whether
an action is genuinely destructive.

Some rules use more than one mode.

A source grep is not accepted as proof of visual behavior that it cannot observe.

---

# A. Architecture

## UI-R01 — No unapproved UI framework/runtime dependency

Karst remains framework-free unless an explicit architecture decision approves a
new frontend runtime or component dependency.

Routine UI work must not add React, Vue, Tailwind, a component framework, or
another frontend runtime dependency.

**Verification:** STATIC

**Check:** UI-only changes do not introduce an unapproved runtime dependency in
`package.json`.

---

## UI-R02 — Use the shared webview delivery path

Shared design-system assets reach webviews through Karst's existing shared
injection/rendering path.

Do not create a screen-specific second delivery mechanism.

Marker injection is a Karst architecture choice, not a claim that CSP prevents
all extension-local resources.

**Verification:** STATIC

**Check:** new shared CSS/behavior is delivered through the shared webview
injection path unless an architecture change is explicitly in scope.

---

## UI-R03 — Every webview receives the complete shared visual system

Every discovered webview contains:

- `<!--KARST_CSP-->`
- `/*KARST_DS_CSS*/`
- `/*KARST_DS_JS*/`

and its host applies the shared design-system injection before CSP processing.

During migration, a separate `/*KARST_PALETTE*/` marker may remain only where the
current implementation still requires it. The target architecture delivers
status/stage palette output through the same mandatory design-system path and then
removes the separate palette marker/calls.

**Verification:** STATIC

**Check:** discovery tests enumerate webviews from disk, not a handwritten list,
assert the required design-system markers/host path, and prevent any webview from
consuming unresolved status/stage tokens during the migration.

---

## UI-R04 — Reusable visual decisions use tokens

Shared/repeated values for:

- color;
- typography;
- recurring spacing;
- shared radius;
- shared component sizing;
- elevation;
- motion;
- layering

use design tokens.

Screen-local structural CSS and genuinely local geometry do not require a global
token.

Do not hide arbitrary dimensions behind meaningless token arithmetic.

**Verification:** STATIC + REVIEW

**Check:** a changed shared/repeated visual value uses an existing/new semantic
token; local geometry is permitted when it belongs to that composition.

A raw-literal budget is not the conformance criterion.

---

## UI-R05 — One semantic role has one definition

Do not create competing definitions for the same semantic visual role.

Different semantic roles may share the same underlying value.

Examples:

- workflow passed and feedback success may share a palette source;
- page background and sunken surface may currently resolve identically.

They remain separate tokens because their meanings differ.

**Verification:** STATIC + REVIEW

**Check:** no second token/source is introduced solely to give an existing
semantic role another screen-specific value.

---

## UI-R06 — Status, feedback, stage, and data-series semantics do not cross

Workflow status, generic feedback, stage identity, and categorical series are
separate semantic namespaces.

Status/stage palette ownership remains centralized.

**Verification:** STATIC

**Check:**

- no webview redeclares status/stage tokens;
- no chart series references workflow/feedback semantic tokens;
- no status/feedback component uses `--k-series-*`.

---

# B. Semantics and primitives

## UI-R07 — Existing semantic controls use shared primitives

If an interaction is already represented by a shared primitive, use that
primitive.

A screen-local layout may position/constrain it.

A local component must not recreate the same semantic primitive with another
appearance.

**Verification:** STATIC + VISUAL

**Check:** changed shared control semantics resolve through the shared primitive;
visual review confirms local composition has not unnecessarily forked it.

---

## UI-R08 — Shared primitives are consistent; local product composition is allowed

The same primitive/variant comes from the shared implementation on every screen.

This rule does not require stage rails, graphs, rows, timelines, or other
product-specific compositions to be promoted into primitives.

**Verification:** STATIC

**Check:** shared primitive/variant declarations are not copied and forked
screen-locally.

---

## UI-R09 — Native element semantics match the interaction

Use:

- `<button>` for actions;
- `<a href>` for navigation and visible resource links;
- native form controls where appropriate;
- `<details>/<summary>` or `<button aria-expanded>` for disclosure.

A host-mediated file/PR/commit reveal still uses link semantics when the visible
resource identifier is the navigation affordance.

Do not use `<div>`, `<span>`, or `<th>` as a click-only replacement.

A custom widget is permitted only when a native control cannot express the
interaction and the complete required keyboard/ARIA behavior is implemented.

**Verification:** STATIC + RUNTIME

**Check:** interactive hooks map to a native interactive element or an explicitly
tested custom widget.

---

## UI-R09b — Interaction state stays on its owner

Busy, disabled, pressed, selected, and transient action-result state belongs to
the interactive element/surface that owns the interaction.

Do not apply button press, `aria-busy`, `:disabled`, or child-action success
state to a non-interactive container merely because it contains the control.

**Verification:** STATIC + VISUAL

**Check:** state selectors/attributes target the actual owner; visual review
confirms row/container state does not falsely imply interaction.

---

## UI-R09c — A visible resource identifier is the navigation affordance

When a row already displays a file path, PR number, commit hash, URL, or other
resource identifier and the intended action is to reveal/open that resource, the
displayed identifier is the link.

Do not add an adjacent **Open file**, **Open PR**, or equivalent button that
duplicates the same navigation.

A separate button is allowed when it performs a different action or when no
meaningful target identifier is displayed.

**Verification:** STATIC + VISUAL

**Check:** finding/detail rows with visible resource targets use the target value
as the link and do not duplicate it with an equivalent adjacent open button.

---

## UI-R10 — Shared visual classes resolve

Every used `k-*` primitive/variant and visual `is-*` state has a defined shared
or local contract.

Behavior-only hooks use `data-*` where a CSS class has no visual role.

**Verification:** STATIC

**Check:** markup tests detect undefined shared primitive/variant classes.

---

## UI-R10b — Irreversible destructive actions use danger treatment

Actions that permanently destroy/remove user data or installed configuration use
the shared danger variant.

This includes:

- permanent delete;
- uninstall;
- destructive discard/remove.

Reversible archive is not automatically danger.

Merge is not automatically danger-colored merely because it is consequential;
required confirmation remains host-side.

**Verification:** STATIC + REVIEW

**Check:** destructive action definitions are mapped to danger treatment using an
explicit action taxonomy, not a broad keyword regex.

---

## UI-R10c — Agent core identity is icon + canonical name

Whenever an agent core is visible, render it through the shared provider identity
mapping as:

**core icon + canonical core name**

The core name is mandatory. The icon is decorative when the visible name is
present.

Model, effort, and variant are optional secondary metadata and are shown only
where they help identify the configured or recorded run.

A generic `AI` badge, model name, or icon alone is not a substitute for the core
identity.

Agent-core selectors must also preserve icon + canonical-name identity for every
choice. A text-only native select does not satisfy this rule; prefer a native
radio/choice pattern or another complete accessible selector.

**Verification:** STATIC + VISUAL

**Check:** agent-core render sites use the shared identity mapping; tests pin the
known core identifier → canonical icon/name mapping; visual review confirms model
/ effort / variant are subordinate metadata rather than replacement identity.

---

# C. Async interaction

These rules specify user-observable interaction behavior.

They do not prescribe request-ID format, one specific dispatcher, or one wire
protocol.

## UI-R11 — Waiting host mutations/long-running actions expose pending state

A control must expose pending state when all are true:

1. it starts a host mutation or external/agent operation;
2. completion is not immediately visible in the same interaction;
3. the control remains present while waiting.

Pending is entered locally on activation rather than after the host result.

Pure navigation/handoff that immediately opens the resulting VS Code surface does
not require an artificial spinner.

**Verification:** RUNTIME

**Check:** qualifying operations have a runtime test proving pending begins
before settlement.

---

## UI-R12 — Unsafe duplicate activation is prevented

While a qualifying operation is in flight, a second activation must not create
duplicate unsafe work.

The mechanism may be:

- native disabled state;
- pending-state guard;
- idempotency;
- application-level deduplication.

**Verification:** RUNTIME

**Check:** double-activation tests for mutations/long-running work assert one
effective operation.

---

## UI-R13 — Known terminal results leave pending and become visible

When the application knows a terminal result, the UI leaves pending and exposes
that outcome.

Prefer the strongest existing home:

1. changed domain state;
2. inline/local result;
3. toast.

**Verification:** RUNTIME

**Check:** success and failure settlement tests clear busy state and expose the
result through the intended UI path.

---

## UI-R14 — Unknown is not failure, and uncertainty is not automatic retry safety

A timeout/lost acknowledgment that cannot establish the operation result is
reported as unknown/uncertain.

It must not be represented as confirmed failure.

A potentially non-idempotent mutation must not simply become re-triggerable after
timeout if the original operation may still be running.

**Verification:** RUNTIME

**Check:** timeout tests assert:

- pending presentation ends or changes to an uncertainty state;
- no false failure claim;
- unsafe duplicate retry is not enabled without reconciliation/idempotency.

---

## UI-R14b — Recoverable form/surface errors preserve recovery context

A form, drawer, or modal that owns a mutation capable of local validation failure
must not destroy its own recovery UI before the result is known.

On failure:

- entered values remain;
- relevant surface remains available;
- field/local error is visible.

**Verification:** RUNTIME

**Check:** failure tests prove the surface remains/reopens with preserved values
and local error association.

---

## UI-R15 — Terminal success is not shown before success is known

Do not show terminal claims such as:

- Saved
- Copied
- Merged
- Deleted
- Installed

before the application knows the operation succeeded when the result is
observable.

Deliberate optimistic UI is allowed only as an explicit reversible/reconcilable
state model; it must not masquerade as confirmed completion.

**Verification:** RUNTIME

**Check:** failure tests never pass through a confirmed-success presentation
first.

---

## UI-R16 — Finite controlled protocol discriminants are closed

When Karst controls both sides of a finite UI/host discriminant, represent it as
a closed set rather than unrestricted `string`.

Unrecognized values are handled explicitly.

**Verification:** STATIC + RUNTIME

**Check:** TypeScript uses a literal union/discriminated union and tests pin the
consumer to every supported member.

No "where practical" exemption applies to finite protocols owned by this
repository.

---

## UI-R17 — Disabled and loading remain distinct

Disabled means unavailable.

Loading means in flight.

A control may be disabled while loading, but busy state remains separately
exposed.

Do not use `pointer-events:none` as the sole disabling mechanism.

Required explanation for an unavailable action must not depend only on native
`title`.

**Verification:** STATIC + RUNTIME + VISUAL

**Check:**

- busy and unavailable state are distinguishable in DOM/state;
- activation is prevented correctly;
- required explanation remains available without pointer-hover-only behavior.

---

## UI-R18 — Pending/result feedback preserves usable geometry and naming

Pending/result UI must not create a layout change that moves the activation
target or neighboring primary controls enough to disrupt continued interaction.

Avoid unnecessary accessible-name changes during the action.

Label changes are allowed when intentional and accessible; they are not
categorically forbidden.

**Verification:** RUNTIME + VISUAL

**Check:** runtime asserts appropriate accessible state; real-webview review
confirms the control/adjacent layout does not jump materially through
idle→pending→settled.

---

# D. Help and accessible naming

## UI-R19 — Required information does not depend on `title`

Native `title` may supplement an interface.

It is not the sole mechanism for:

- accessible name;
- unavailable-action explanation;
- validation guidance;
- instructions required to use the control.

**Verification:** STATIC + VISUAL

**Check:** required meaning remains available when native tooltip presentation is
ignored.

---

## UI-R20 — Supplemental tooltip copy is concise and useful

Where a title/custom tooltip exists, it describes behavior rather than widget
type and does not redundantly repeat an obvious visible label.

The existing 80-character bound remains a copy guard for transient tooltip text.

**Verification:** STATIC + REVIEW

**Check:** `title` values are ≤80 characters and review confirms they add useful
behavioral context.

---

## UI-R21 — Supplemental tooltip text agrees with the accessible name

When an icon-only control has both an accessible name and supplemental tooltip
text, the two must describe the same action and scope.

For simple icon actions, exact equality between `aria-label` and `title` is
preferred. Different wording is allowed only when it adds supplemental context
without changing the action's meaning.

This rule governs **agreement between two descriptions**. The requirement that an
icon-only control has an accessible name at all is UI-R24.

**Verification:** STATIC + REVIEW

**Check:** controls carrying both `aria-label` and `title` are compared for
semantic agreement; simple one-action icon controls should normally use the same
string.

---

## UI-R22 — Custom tooltip/help behavior supports keyboard users

A custom tooltip/help surface containing useful information must be accessible
from keyboard focus as well as pointer hover.

It must not create a keyboard trap.

**Verification:** RUNTIME + VISUAL

**Check:** keyboard interaction test/review exercises focus, appearance, and
dismissal.

---

# E. Accessibility

## UI-R23 — Keyboard focus is visibly identifiable

Every keyboard-focusable interactive element has a clearly visible focus
indicator.

A non-rectangular control may use a shape-aware focus treatment.

Do not remove focus presentation without replacement.

**Verification:** STATIC + VISUAL

**Check:**

- shared primitives include a focus-state contract;
- keyboard through every changed surface in light, dark, and high-contrast mode;
- focus remains visually identifiable.

---

## UI-R24 — Icon-only controls have accessible names

An icon/glyph alone is not the control's accessible name.

Decorative icons are hidden from assistive technology when text or an
`aria-label` already names the control.

**Verification:** STATIC

**Check:** icon-only control tests assert accessible names and decorative icon
treatment where applicable.

---

## UI-R25 — Form controls have labels and local error association

Each form control has a programmatic label.

A placeholder is not a label.

Field-specific errors are programmatically associated with the field and expose
invalid state.

**Verification:** STATIC + RUNTIME

**Check:** markup tests verify label association; error-state tests verify
`aria-invalid` and description association.

---

## UI-R26 — ARIA reflects actual state

ARIA state is updated with the real component state.

Examples:

- `aria-busy`;
- `aria-expanded`;
- `aria-pressed`;
- `aria-checked`;
- `aria-invalid`;
- `aria-current`.

Prefer native semantics before custom ARIA.

A custom radio group implements expected keyboard navigation, not only
`aria-checked`.

**Verification:** RUNTIME

**Check:** interaction tests verify each changed ARIA state tracks actual state.

---

## UI-R27 — Important asynchronous changes have an announcement path

A change that would otherwise be missed by assistive-technology users has an
appropriate status/live-region announcement path.

Do not announce every rerender.

Ordinary transient results use one coordinated polite status region per webview
unless a more local semantic element already provides the announcement.

**Verification:** STATIC + RUNTIME

**Check:** qualifying completion/error flows update an announcement path.

---

## UI-R28 — Color is not the only visible carrier of meaning

Meaningful state remains identifiable without distinguishing its hue.

Use a distinct glyph, shape, pattern, or visible text.

Workflow status intentionally uses icon-only markers: check / spinner / pause /
cross / neutral marker. The different glyph/shape is the non-color carrier.

An `aria-label` alone does not satisfy this rule for sighted users.

**Verification:** VISUAL

**Check:** review the changed state while suppressing color distinction; its
meaning remains visually identifiable from glyph/shape/text.

---

## UI-R28b — Workflow status markers are icon-only and use the shared mapping

The `.k-status` primitive renders no visible status word.

Required mapping:

- passed / done → green checkmark;
- running → blue spinner;
- needs attention / paused / blocked → amber pause icon;
- failed → red cross;
- pending / not checked → neutral circle/dot.

Every marker has an accessible name describing the actual state.

Surrounding row copy may describe the status where useful; that copy is not part
of the status primitive.

**Verification:** STATIC + VISUAL

**Check:** status renderers use the shared state→icon/color mapping, contain an
accessible name, and do not append a visible status word inside the primitive.

---

## UI-R29 — Contrast meets WCAG AA

Normal text requires at least `4.5:1`.

Use the lower `3:1` text threshold only where text actually qualifies as large
text under WCAG. `14px` semibold Karst headings remain normal text for this rule.

Required non-text UI indicators/boundaries meet their applicable contrast
requirements.

Theme-dependent pairs are not assumed to pass merely because they come from
theme variables.

Shared/reusable component CSS must not embed dark-theme surface/text/border
literals that bypass the semantic token layer.

**Verification:** STATIC + VISUAL

**Check:**

- Karst-owned fixed semantic foreground/background pairs have pinned contrast
  tests;
- changed surfaces are checked in VS Code light, dark, and high-contrast theme
  classes.

---

## UI-R30 — Reduced motion preserves state information

Reduced-motion mode removes/reduces non-essential animation.

All state remains understandable without movement.

**Verification:** STATIC + VISUAL

**Check:** shared motion has a reduced-motion rule and the changed screen is
reviewed with reduced motion enabled.

---

# F. Host / webview boundaries

## UI-R31 — Host supplies semantic facts; webview owns visual presentation

The host owns:

- domain/business state;
- permissions;
- persistence;
- external results;
- consequential decisions.

The webview owns:

- component selection;
- CSS classes;
- glyphs;
- visual tokens;
- layout;
- presentation-only formatting.

Prefer:

```ts
{
  status: 'running',
  stage: 'uat',
  canMerge: false,
  agentCore: 'claude-code',
  model: 'opus-5'
}
```

`agentCore` is semantic identity. The shared provider identity module maps it to
the canonical icon/name; domain code does not send presentation glyphs/classes.

over:

```ts
{ className: 'green-pill', color: '#4bb64b' }
```

Canonical formatting that changes meaning remains upstream.

Purely visual formatting may remain in the presentation layer.

**Verification:** STATIC + REVIEW

**Check:** host/domain view models do not prescribe CSS classes/colors for
ordinary presentation; webview formatters do not duplicate business/domain
classification logic.

---

## UI-R32 — Untrusted prose is escaped and bounded for its destination

External strings from:

- CLI;
- git;
- agents;
- providers;
- workspace data

are escaped for their output context.

Transient UI such as toasts, badges, labels, and tooltips bounds/collapses
external prose so it cannot become a raw diagnostic dump.

Dedicated detail/log surfaces may intentionally expose longer content.

**Verification:** STATIC + RUNTIME

**Check:** interpolation helpers are used; tests cover transient-output
truncation/collapse.

---

## UI-R33 — Protected irreversible confirmation stays host-side

Where confirmation must not be bypassable by a crafted webview message, the host
performs the confirmation using the approved VS Code mechanism.

The webview posts intent.

**Verification:** STATIC + RUNTIME

**Check:** protected irreversible handlers retain host-side confirmation and
tests prevent direct webview intent from skipping it.

---

## UI-R34 — Mirrored behavior constants remain pinned

Existing TS↔webview mirrored behavior blocks are not modified as incidental UI
cleanup.

Examples include:

- `SECTION_FIELDS`;
- `TICKET_TYPES`;
- `CONVENTION_PRESETS`;
- `TRANSFORM_NAMES`;
- `deriveKey` / `TITLE_KEY_MAX`;
- `MAX_PASTE_BYTES`;
- `briefToText`.

A required change is treated as a behavior change with dedicated tests/review.

**Verification:** STATIC

**Check:** existing pinning tests remain green unless explicitly changed in
scope.

---

# G. Verification and change control

## UI-R35 — Rule-driven remediation is traceable

A change made specifically to satisfy/correct a UI rule cites the rule ID in the
commit/PR, or in a nearby comment when the reason would otherwise be unclear.

Do not add rule IDs as ceremony to unrelated changes.

**Verification:** REVIEW

---

## UI-R36 — Use a test that can prove the property

### Static tests are appropriate for

- markers;
- native element structure;
- accessible-name presence;
- status state→icon mapping;
- agent-core identity mapping;
- resource-link structure;
- token/class ownership;
- mirrored constants;
- finite protocol discriminants.

### Runtime tests are appropriate for

- pending/settled state;
- duplicate activation;
- toast dismissal;
- ARIA state;
- validation recovery;
- announcements.

### Visual verification is required for

- focus visibility;
- reflow/layout stability;
- clipping;
- hierarchy;
- light/dark/high-contrast appearance;
- contrast involving theme-dependent values;
- modal focus experience;
- color-independent readability;
- reduced motion.

A literal/regex budget is not a substitute for rendered verification.

**Verification:** STATIC + RUNTIME + VISUAL

---

## UI-R37 — Domain behavior is preserved unless explicitly in scope

A design-system/presentation task must not silently change:

- domain meaning;
- persistence;
- permissions;
- host command selection;
- irreversible behavior;
- workflow transitions.

Intentional interaction/accessibility improvements are allowed, including:

- duplicate-activation prevention;
- pending feedback;
- correct validation recovery;
- accessible focus/ARIA;
- safer unknown-result handling;
- improved result presentation.

These are interaction changes and must be tested as such; they are not prohibited
by a generic "no behavior change" rule.

**Verification:** STATIC + RUNTIME

**Check:** `npm test` and `npm run typecheck` pass, and behavior changes introduced
by UI remediation have dedicated coverage.
