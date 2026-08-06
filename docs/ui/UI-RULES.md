# Karst UI Rules — binding on every agent and human touching the UI

These rules are **normative**. An agent producing or modifying any file under
`src/ui/` or any `webview.html` is bound by them, and its output is judged
pass/fail against them.

Each rule has an id (`UI-R##`), a single testable claim, and a **Check** — the
concrete way to decide pass/fail. Cite the rule id in the commit or PR when a
change exists to satisfy it.

Definitions and values live in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md).
Application guidance lives in [STYLE-GUIDE.md](./STYLE-GUIDE.md).

> **Precedence.** These rules sit under the repository's architecture invariants
> in `CLAUDE.md`/`AGENTS.md`. Where a rule here would break an invariant there,
> the invariant wins and the conflict is a defect in this document — report it,
> do not route around it.

---

## A. Foundation

### UI-R01 — No new UI framework or component library
Build on what exists: self-contained `webview.html`, inline `<style>`/`<script>`,
marker injection from TS. Adding React/Vue/Tailwind/a component package, or a
runtime dependency for the UI, is refused unless the PR carries an explicit
written justification accepted by the user.

**Check:** `package.json` `dependencies` unchanged by a UI change.

### UI-R02 — The design system is delivered by marker injection, not by import
Shared CSS/JS reaches a webview only through a marker replaced host-side
(`/*KARST_DS_CSS*/`, `/*KARST_DS_JS*/`), because CSP forbids `<link>`, external
`<script>`, `url()`, `@font-face`, and `fetch()`.

**Check:** no `<link>`, no `src=` on a `<script>`, no `@import`, no `url(http…)`
in any `webview.html`.

### UI-R03 — Every webview carries every marker
A webview must contain `<!--KARST_CSP-->`, `/*KARST_DS_CSS*/`, and
`/*KARST_DS_JS*/`, and its host must call `injectDesignSystem` before
`injectCsp`.

**Check:** `src/ui/designSystem.test.ts` discovers webview directories from disk
and asserts the markers — it must not be given a hand-written list.

### UI-R04 — Tokens are the only legal style values
No component may contain a raw hex colour, `rgb()`/`rgba()`/`hsl()` literal, raw
`px`/`rem` spacing, font size, radius, shadow, duration, or z-index. Use the
token. If no token fits, add one to `designSystem.ts` and to
[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) — do not inline a value.

**Exempt:** `1px` hairlines expressed as `var(--k-border-w)`, `0`, `100%`,
`50%` via `--k-radius-circle`, and the token definitions themselves.

**Check:** in a remediated file, `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|[0-9]+(\.[0-9]+)?(px|rem)'`
inside `<style>` returns only token declarations.

### UI-R05 — One semantic value has exactly one token
A colour meaning ("failed", "done") resolves through one token everywhere. Never
introduce a second name, a second VS Code source variable, or a second hex
fallback for a meaning that already has one.

**Motivating defect:** six greens, five reds, three purples; and
`var(--vscode-testing-iconPassed, …)` written with fallback `#73c991` in
`diffs/webview.html` and `#3fb950` in `welcome/webview.html` — the *same*
variable, two different results on a theme that omits it.

**Check:** every colour in a remediated file is `var(--k-*)`; the distinct set of
hex literals across `src/ui/*/webview.html` shrinks and never grows.

### UI-R06 — Status colour comes from the existing ramp
`--k-pending|running|attention|passed|failed` (from `src/model/palette.ts`) and
the stage ramp (`src/model/stagePalette.ts`) are consumed, never redefined and
never shadowed. Feedback tokens (`--k-success|warning|danger|info`) are aliases
onto that ramp.

**Check:** no webview redeclares a `--k-*` status token.

---

## B. Primitives

### UI-R07 — Use a primitive; do not restyle a control
Every button is `.k-btn` or `.k-iconbtn` with a variant. A `<button>` that
overrides `background`, `border`, `padding`, `border-radius`, or `font-size`
locally is a defect — pick the right variant, or add a variant to the design
system.

**Motivating defect:** four radii (2px/3px/4px/5px) for the same primary button
across four files; `diffs`' `.file` and `.copy-hash` each de-style a `<button>`
into something unrecognizable as a control.

**Check:** in a remediated file, no rule whose selector matches a `<button>`
sets those five properties outside `designSystem.ts`.

### UI-R08 — Visually equivalent controls render identically
The same conceptual control (secondary button, icon button, toggle chip) uses
the same primitive and the same tokens on every screen. Screen-specific layout
(width, position, grid placement) is allowed; screen-specific *appearance* is not.

**Check:** the same variant class produces byte-identical declarations, because
they come from one emitted stylesheet.

### UI-R09 — Semantics match the element
An action is a `<button>`. Navigation is an `<a href>`. A disclosure is
`<details>/<summary>` or a `<button aria-expanded>`. A `<div>`/`<span>`/`<th>`
with a click handler is a defect.

**Motivating defects:** `usage`'s sortable `<th data-sort>` (click handler, no
role, no `tabindex`, no key handler — unreachable by keyboard); `sidebar`'s
`.chev` `<span data-toggle>` and `.row` `<div data-open>`; `sidebar`'s `#emptyNew`
`<a>` with no `href`.

**Check:** every `data-act`/`data-*` click target in a remediated file is a
`<button>` or an `<a href>`. Where a non-native control is genuinely required it
carries `role`, `tabindex="0"`, and <kbd>Enter</kbd>+<kbd>Space</kbd> handlers —
and that exception is justified in a comment.

### UI-R09b — Interactive states stay on the primitive
`:active` (press scale), `[aria-busy]` (spinner), `.is-success` (flash), and
`:disabled` apply **only** to the interactive element itself — a `<button>` or
an `<a href>` — never to a non-interactive container wrapping it (a `<div>`,
`<span>`, or layout row). A row that scales `.96` on press, shows a spinner
badge, or goes opaque on disable is a defect: the state leaked from the child
control to its parent.

**Motivating defect:** the design system's `:active { transform: scale(.96) }`
was applied to `.row` (a `<div>`) during the rollout, so clicking anywhere on a
ticket row — including the name text — produced a visible depress, even though
the row is not a button and does not post a message.

**Check:** no `:active`, `[aria-busy]`, `.is-success`, or `:disabled` rule
targets an element that is not a `<button>`, `<a>`, `<input>`, `<select>`,
`<textarea>`, or a known interactive primitive (`.k-btn`, `.k-iconbtn`,
`.k-chip`, `.k-switch`, `.k-input`).

### UI-R10 — A class must have a rule
Applying a class that no stylesheet defines is a defect.

**Motivating defect:** `ticketForm`'s `#attachBtn.ghost` — `.ghost` has no CSS
anywhere in that file, so the "ghost" button renders as a primary button.

**Check:** every class used in markup resolves to a rule in the file or in the
injected design system.

---

### UI-R10b — A destructive control looks destructive
Any control that deletes, removes, uninstalls, archives, or merges uses
`.k-btn--danger` / `.k-iconbtn--danger` and carries a `title` naming what is
lost. It must never be visually indistinguishable from a benign secondary
action.

**Motivating defect:** `settings` has **no danger variant anywhere in its
stylesheet** — "Delete" (agent), "Remove" (repository), and "Uninstall"
(approach) render as the same plain `.secondary` as "Cancel" and "Reload".

**Check:** every `data-act`/handler matching `delete|remove|uninstall|archive|merge`
carries the danger variant.

---

## C. Async interaction feedback

### UI-R11 — Every async control shows a pending state
Any control that posts a message to the host enters pending **on click**,
locally, before any round trip: `aria-busy="true"`, `disabled`, and a
`.k-spinner`.

**Motivating defect:** `aria-busy` appears **0** times in the entire UI today.

**Check:** `grep -c 'aria-busy' src/ui/*/webview.html` > 0 for every webview that
has an async control; every `post({type:…})` call site for a mutating action goes
through the shared async-action runtime.

### UI-R12 — A pending control is not re-triggerable
While pending, a second activation is dropped — not queued, not re-sent. Pending
state is keyed by control identity in the shared runtime, so this is structural
rather than per-control discipline.

**Motivating defect:** `welcome`'s "Create karst.yml" writes a file to disk and
is not disabled during the `await`; `sidebar`'s `delete`/`archive`/`spin` are
fire-and-forget with nothing preventing repeats.

**Check:** a unit test drives a double activation through the runtime and asserts
one post.

### UI-R13 — Every async action reports a terminal outcome
Pending must end in a visible success or a visible failure. The host replies once
per request with `{type:'action-result', requestId, ok, message?}` from the single
dispatch seam; the runtime settles the control on it.

**Check:** every webview's host-message union includes `action-result`; the
dispatcher emits exactly one per parsed request.

### UI-R14 — A control can never be stuck pending
The runtime arms a watchdog on entering pending. On expiry the control leaves
pending and reports that the outcome is **unknown** — which is not the same
claim as failure and must not be worded as one.

**Check:** a unit test advances fake timers past the watchdog and asserts the
control is re-enabled and `aria-busy` cleared.

### UI-R14b — A surface does not close before its action settles
A modal or drawer whose Save/submit posts an async action stays open, with its
control pending, until the terminal result arrives. It closes on success. On
failure it stays open and renders the error **inside itself**, next to the field
that caused it.

**Motivating defect:** `settings`' approach drawer calls `closeApproachDrawer()`
on the line after `post()`, ungated. A host validation failure then has nowhere
to render — it falls back to the global `#errBanner` behind a closed drawer, and
the user cannot see which field was rejected without reopening and guessing.

**Check:** no `close*()` call is unconditionally adjacent to a `post()` of a
mutating action.

### UI-R15 — Optimistic feedback only where failure does not matter
Showing success before the host confirms is permitted only for actions whose
failure the user does not need to act on (a clipboard write), and the optimism
must be stated in a comment. Never for a mutation.

**Motivating defect:** `diffs`' `.copy-hash` shows "✓ Copied" regardless of
whether the host clipboard write threw. Acceptable *only* because it is a
clipboard write; the same pattern on a merge or delete would not be.

**Check:** no `flash*`/optimistic helper is invoked from a mutating action.

### UI-R16 — Busy vocabularies are closed
A busy/result discriminant is a union of literal types, never `string`. An
unrecognized value is handled explicitly, not dropped.

**Motivating defect:** `TicketFormHostMessage` declares `{type:'busy'; what: string}`;
the host posts `what:'suggest'` and the webview's `setBusy` switch has no
`'suggest'` case, so the Suggest button's pending state is silently swallowed and
never rendered.

**Check:** `what` is a closed union in TS; the webview's switch handles every
member; a test pins the two together.

### UI-R17 — Disabled and loading are different states
`disabled` means unavailable — and the control keeps a `title` explaining why.
`aria-busy` means in flight. A control disabled *because* it is loading carries
both; a control disabled for any other reason carries only `disabled`.
`pointer-events:none` must not be used to disable, because it suppresses the
tooltip that explains the disablement.

**Check:** no `pointer-events:none` on an interactive element; every statically
disabled control has a `title`.

### UI-R18 — A control's label does not change while pending
The accessible name is stable across the action. The spinner carries the pending
meaning. `Save` → `Saving…` → `Save` is refused: it mutates the accessible name
mid-action and reflows the control's width.

**Check:** no `textContent`/label assignment inside a pending branch.

---

## D. Tooltips

### UI-R19 — A tooltip is required when the label is not sufficient
A `title` is **mandatory** on: every icon-only control; every control whose label
is a bare verb whose object is not visible ("Open", "Suggest", "Spin"); every
control that is destructive or irreversible; every statically disabled control
(explaining why); and every control whose effect is not confined to the visible
screen.

A tooltip is **forbidden** where it merely restates a self-evident text label.

**Check:** every `.k-iconbtn` in markup has both `title` and `aria-label`.

### UI-R20 — Tooltip text is bounded and behavioural
Max **80 characters**, one sentence, no trailing period. It says what the control
does, not what it is: "Re-probe every PR", not "Refresh button".

**Check:** a test asserts every `title="…"` in every webview is ≤ 80 chars.

### UI-R21 — Tooltip and accessible name agree
On an icon-only control, `title` and `aria-label` are the **same string**. Two
different strings mean the pointer user and the screen-reader user are told two
different things.

**Check:** a test extracts icon-only controls and compares the pair.

### UI-R22 — Tooltips are keyboard-reachable
Use the native `title` attribute. A custom tooltip is permitted only if it also
appears on `:focus-visible`, not only on `:hover`, and is dismissible with
<kbd>Esc</kbd>.

**Check:** no custom tooltip implementation binds only `mouseenter`.

---

## E. Accessibility

### UI-R23 — Visible focus, everywhere
Every focusable element shows `outline: var(--k-focus-w) solid var(--k-focus)` at
`var(--k-focus-offset)`. `outline:none` without a replacement ring is refused.

A replacement ring need not be an `outline`: an element that is not rectangular
cannot be outlined by one, because `outline` is a rectangle and a `clip-path`
cuts whatever falls outside the shape — the dashboard track's chevron segments
lost the ring's vertical strokes inside their notches. Such an element may draw
the ring as a shape instead (there, `--k-focus` filling the segment clipped to
the chevron minus a smaller chevron), as long as `--k-focus` is what draws it and
the fallback for a browser that cannot compute the shape is the plain outline.

**Motivating defect:** `sidebar` and `welcome` define **no** `:focus-visible`
rule at all; `usage` covers only bare `button`.

**Check:** `grep -c ':focus-visible' src/ui/*/webview.html` > 0 for every
webview — satisfied by the injected design system, not per-file.

### UI-R24 — Icon-only controls have accessible names
Every control whose visible content is only a glyph or SVG has an `aria-label`.
`title` alone is not an accessible name.

**Motivating defect:** every `.ia` row action in `sidebar` (unarchive, delete,
spin, open-session, edit, archive) has `title` and no `aria-label`.

**Check:** no `<button>` with only an SVG/glyph child lacks `aria-label`.

### UI-R25 — Form controls have real labels
A `<label for>` per control. A placeholder is not a label. A field in error
carries `aria-invalid="true"` and `aria-describedby` pointing at its message.

**Motivating defect:** `ticketForm`'s generated `#sig-${svc}` inputs have no
`<label for>`; `#ref`/`#title`/`#desc` never get `aria-invalid` or
`aria-describedby` when `#err` fires.

**Check:** every `<input>`/`<select>`/`<textarea>` id is referenced by a
`<label for>` or the control carries an `aria-label`.

### UI-R26 — ARIA state reflects real state
`aria-busy` while pending · `aria-expanded` on every disclosure trigger ·
`aria-pressed` on toggle buttons · `aria-checked` on `role="switch"`/`role="radio"` ·
`aria-current` on the active wizard step · `aria-invalid` on a field in error.

**Motivating defects:** `ticketForm`'s `#detailsBtn` opens a drawer with no
`aria-expanded`; its repo `.chip` (`role="button"`) has no `aria-pressed` and its
approach `.acard` (a radio in effect) has no `aria-checked`; its stepper conveys
done/active purely by CSS class with no `aria-current`.

### UI-R27 — Changes not caused by the user are announced
Every webview has exactly one `role="status" aria-live="polite"` region (the
toast container). Pending completion, results, and progress steps are announced
through it.

**Motivating defect:** `dashboard` has no live region at all — ship progress,
merge completion, and refresh completion are silent to assistive tech;
`welcome`'s `#error` and `usage`'s `#err` have no `role`/`aria-live`.

### UI-R28 — Colour is never the only carrier
Status is also carried by a glyph, a letter, or text. A status dot is
`role="img"` with an `aria-label` naming the status in words.

**Motivating defect:** `diffs`' A/M/D/R status letters are colour + a bare
letter, never expanded to "Modified"; `welcome`'s `.mark` ✓/✗ glyphs have neither
`aria-label` nor `aria-hidden`.

### UI-R29 — Contrast meets WCAG AA by construction
4.5:1 for body text, 3:1 for ≥`--k-text-lg` semibold and for component
boundaries. Guaranteed by using **paired** tokens (`--k-action-fg` on
`--k-action-bg`, `--k-danger-fg` on `--k-danger`), never by hand-picking a
foreground against a themed background.

**Motivating defect:** `dashboard` line 417 sets `background:#8957e5;color:#fff`
with no theme variable on either side.

**Check:** no bare `color:#fff`/`#000` paired with a themed background.

### UI-R30 — Motion is optional
Every animation and transition is nulled under
`@media (prefers-reduced-motion: reduce)`, and no information is lost when it is.
The pending state survives because it is carried by `aria-busy` and `disabled`,
not by the spinner's rotation.

**Motivating defect:** of seven webviews only `diffs` has a reduced-motion query.

---

## F. Boundaries

### UI-R31 — The webview decides nothing
Values arrive pre-formatted from the host: numbers, durations, paths, verdicts,
labels, colours, classes. A formatter or a business rule inside a `webview.html`
is a second implementation of a rule that already exists host-side.

### UI-R32 — Untrusted prose is bounded before it is displayed
Any string originating from a CLI, an agent, a git command, or a provider is
collapsed to one line and length-capped before it reaches a toast, a label, or a
tooltip — the rule `agent/cliFailure.ts` already applies to verdicts and logs.

### UI-R33 — Confirmation of an irreversible action lives host-side
A destructive action is confirmed by a VS Code modal in the host, never by a
webview dialog, so a crafted message cannot skip it. The webview posts intent
only; it never picks the strategy.

### UI-R34 — Mirrored constants stay pinned
Blocks mirrored from TS into a webview (`SECTION_FIELDS`, `TICKET_TYPES`,
`CONVENTION_PRESETS`, `TRANSFORM_NAMES`, `deriveKey`/`TITLE_KEY_MAX`,
`MAX_PASTE_BYTES`, `briefToText`) are behaviour, not styling. A UI change must
not touch them, and their pinning tests must keep passing untouched.

---

## G. Verification

### UI-R35 — Remediation is traceable
Every remediation change cites the rule id it satisfies, in the commit body or in
a code comment where the reason is not evident from the diff.

### UI-R36 — Tests cover the matrix and the feedback, not just the markup
A change that adds or alters a primitive adds tests for its **state matrix**, and
a change that adds an async control adds tests for **pending / non-re-trigger /
terminal result / watchdog**. Webview HTML is asserted at text level (the repo
has no DOM harness and adding one is out of scope); the shared runtime is tested
by evaluating the **emitted JS itself** against a fake DOM, so there is no second
copy to drift.

### UI-R37 — Behaviour is preserved
This is a presentation and interaction-feedback contract. No rule here licenses
changing what an action does, which message it posts, what the host executes, or
what is persisted. `npm test` and `npm run typecheck` pass.
