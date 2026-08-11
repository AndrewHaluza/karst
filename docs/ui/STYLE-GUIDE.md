# Karst UI Style Guide

**Version:** 3.0 — finalized UI application guide

How to apply the [Design System](./DESIGN-SYSTEM.md).

[UI-RULES.md](./UI-RULES.md) defines what is mandatory. This document
explains the product/design judgment behind those rules.

---

# 1. Visual north star

Karst should feel like a focused developer tool inside VS Code:

- compact;
- information-dense;
- calm;
- structurally clear;
- low-chrome;
- explicit about workflow state;
- precise rather than decorative.

The latest approved prototype from the design-system revamp review is the current
visual north star.

Before future visual redesign work, capture it as a stable repository visual
reference, preferably under `docs/ui-reference/` with approved screenshots or the
final prototype HTML plus a short README explaining which characteristics are
normative and which are exploratory.

An external prototype/share link is useful review provenance, but must not become
the permanent normative dependency.

When a mechanical rule conflicts with a composition that is clear, accessible,
consistent, and matches the approved visual direction, review the rule before
flattening the design.

---

# 2. Naming

## CSS

| Kind | Convention | Example |
|---|---|---|
| shared primitive | `.k-<noun>` | `.k-btn`, `.k-badge` |
| shared variant | `.k-<noun>--<variant>` | `.k-btn--danger` |
| runtime state | `.is-<state>` when native/ARIA state is insufficient | `.is-success` |
| local composition | unprefixed | `.stageRail`, `.repoGrid`, `.rowActions` |

`k-` means **shared contract**.

It does not mean every visually interesting element belongs in the design
system.

A local class may own:

- layout;
- geometry;
- position;
- grid/flex composition;
- a genuinely screen-specific visual component.

A local component must **not recreate an existing semantic primitive**.

If something is semantically a normal Karst button, it uses `.k-btn`.
Calling the replacement `.localAction` does not make a second button system
acceptable.

---

# 3. Reuse vs local design

Ask these questions in order.

## 3.1 Does an existing primitive match the interaction?

Use it.

Examples:

- action → button;
- navigation → link;
- information label → badge;
- agent core → agent-core identity;
- compact toggle → chip;
- modal overlay → modal/drawer.

## 3.2 Is the same semantic component missing a real variant?

Add a shared variant.

Variants encode meaning:

- primary;
- secondary;
- ghost;
- danger;
- text.

They do not encode taste:

- purple;
- slightly rounder;
- dashboard version.

## 3.3 Is this a product-specific composition?

Keep it local.

Examples:

- stage rails;
- implementation graphs;
- workflow nodes and edges;
- ticket timelines;
- diff-file structures;
- repo grids;
- usage visualization;
- complex settings layout.

Promotion is based on a stable reusable semantic/API contract—not an arbitrary
"used on two screens" count.

---

# 4. Tokens

Use a token for a repeated visual decision.

```css
.card {
  padding: var(--k-space-6);
  border: var(--k-border-w) solid var(--k-border);
  border-radius: var(--k-radius-md);
}
```

A one-screen geometry value may stay local:

```css
.stageRail {
  grid-template-columns: 164px minmax(0, 1fr);
}
```

Do not produce arithmetic puzzles just to avoid literals:

```css
/* Don't */
width: calc(var(--k-space-8) * 23);
```

If a local value becomes part of a shared component contract, promote it to a
meaningful component token.

---

# 5. Color semantics

Always decide **what the color means** before deciding which token to use.

Keep separate:

- workflow status;
- feedback;
- stage identity;
- categorical data series;
- selection.

## Don't

```css
.merged {
  background: var(--k-series-2);
}
```

A chart color does not mean merged.

## Don't

```css
.note {
  color: var(--k-running);
}
```

Information does not mean running.

## Do

```css
.error {
  color: var(--k-danger);
}
```

or:

```css
.runningStatus {
  color: var(--k-running);
}
```

Different semantic tokens may currently resolve to the same hue.

---

# 6. Density and typography

Preserve Karst's compact density.

Do not enlarge spacing, typography, control heights, or surface padding as an
incidental consequence of cleanup.

Choose from the existing typography scale by role.

Avoid adding new near-duplicate sizes to solve one local alignment issue.

A fractional size already present in the approved visual baseline is not a
reason to create more fractional sizes.

Retuning the type scale is a design task, not token hygiene.

---

# 7. Buttons, links, and resource paths

Semantics come before appearance.

## Action

```html
<button class="k-btn k-btn--text">Show details</button>
```

## Navigation

```html
<a class="k-link" href="...">Open documentation</a>
```

## File / resource reveal

When a file path, commit hash, PR number, or other useful target identifier is
already visible, make that value the link:

```html
Fix process runs carry no pid —
<a class="k-link mono" href="...">src/store/recoveryRounds.ts:693</a>
```

Do **not** render:

```text
Fix process runs carry no pid — src/store/recoveryRounds.ts:693    [Open file]
```

The extra button duplicates the same navigation and makes dense process rows
heavier.

If the host must mediate the reveal, route the link activation through the host
while keeping link semantics.

Do not call navigation a button because it looks like one.

Do not use an anchor for an action merely because you want link styling.

---

# 8. Destructive actions

Always-danger actions include:

- permanent delete;
- uninstall;
- destructive remove/discard;
- irreversible deletion of stored data.

Reversible or consequential actions are not automatically danger-colored.

For example:

- **Archive** may be an ordinary action if it is safely reversible.
- **Merge** may be primary/consequential rather than visually destructive; its
  security-sensitive confirmation remains host-side where required.

Choose danger based on **destructive loss**, not keyword matching.

---

# 9. Rows

Rows are a core Karst composition and should remain row-like.

A row may contain:

- primary label;
- metadata;
- status;
- stage;
- disclosure;
- child actions.

Do not automatically give the whole row button chrome.

## 9.1 Whole-row interaction

If the whole row is the single action and contains no independent interactive
children, the row may use appropriate native clickable semantics.

## 9.2 Row with child actions

If the row contains independent controls such as:

- delete;
- archive;
- menu;
- expand;
- open session;

do not wrap the entire row in a `<button>` or `<a>` and create nested interactive
elements.

Instead:

- keep the row a layout container;
- expose the primary action as its own control/link;
- keep secondary actions independent.

Do not put `:active`, busy, disabled, or success states on the row when a child
control owns the action.

For findings/log/detail rows, a visible filepath is itself the navigation link.
Do not add a redundant **Open file** button beside the same path.

---

# 10. Selection, success, and status

These are different meanings:

```text
selected
successful action
workflow passed
currently active
currently running
```

Do not collapse them into one green or selected wash.

A selection wash means:

> this item is selected

A transient success treatment means:

> the action completed

A workflow status means:

> this process is in this state

They may be visually related, but they are not aliases.

---

# 11. Workflow status

Workflow status is intentionally compact: **icon only**.

The shared mapping is:

| Meaning | Marker |
|---|---|
| passed / done | green checkmark |
| running | blue spinner |
| needs attention / paused / blocked | amber pause icon |
| failed | red cross |
| pending / not checked | neutral circle/dot |

The status marker itself contains no visible word.

Its accessible name still names the actual state (`Passed`, `Done`, `Needs
attention`, and so on).

Surrounding row copy may explain the state when useful:

```text
[green check] Gates       3/3 command gates passed
[neutral dot] Services   not checked — no services reported for this ticket
```

The visible summary is row content, not part of the status primitive.

This satisfies the non-color rule through distinct glyphs/shapes rather than
repeating a status label next to every icon.

---

# 11.1 Agent core identity

Agent-core identity is always:

**icon + canonical core name**

Use the shared identity mapping from `providerIdentity.ts`.

Good:

```text
Review Agent · <icon> Claude Code · Opus 5
Implementation Agent · <icon> Codex · GPT-5.6 · high
PR Agent · <icon> OpenCode · mimo-v2.5-free
```

The role (`Review Agent`, `UAT Agent`, `PR Agent`) is contextual copy.

The core identity (`icon + Claude Code`, `icon + Codex`, and so on) is shared
presentation.

Append model only where it adds useful context. Append effort or variant only
when it matters for the configured/recorded run.

Do not use:

- bare `Claude Code` without its shared icon;
- icon-only agent identity;
- model-only identity;
- a generic `AI` pill as a replacement for core identity.

Usage totals and timing remain separate metadata.

When the user is choosing an agent core, use a single-choice UI that can render
the same icon + name identity for every option. Do not fall back to a text-only
native select just because it is convenient. Native radio inputs with styled
labels are preferred when they fit.

---

# 12. Stages

Karst stages are product identity:

```text
Scope → Implement → UAT → Review → Ship → Done
```

Preserve their hierarchy and visual relationship.

Do not replace stage identity with generic success/info/warning badges.

Screen-specific stage structures such as rails, nodes, implementation graphs,
and timelines may remain local compositions.

---

# 13. Badges, chips, and choices

## Informational badge

```html
<span class="k-badge">Review</span>
```

No pressed state. No fake button role.

Agent-core identity is not represented by a badge; use the shared
icon + core-name pattern from §11.1.

## Toggle chip

```html
<button class="k-chip" aria-pressed="true">Backend</button>
```

It is an action/selection control.

## Single choice

Prefer native radio controls with styled labels.

If a custom radio group is necessary, implement the whole interaction, including
arrow-key navigation and focus management.

---

# 14. Copy tone

Karst speaks like a competent colleague.

Direct, specific, neutral.

## Labels

Prefer imperative verb + object:

- **Create ticket**
- **Resolve conflicts**
- **Open log**
- **Switch agent…**

Use sentence case.

Use an ellipsis only where the action genuinely opens another decision.

## Errors

Use:

**what failed → why, if known → what to do**

Example:

> Could not refresh ticket changes: worktree is missing. Re-spin the ticket.

Do not expose raw:

- stack traces;
- provider JSON;
- CLI envelopes;
- internal logs

in transient UI.

"Unknown" and "failed" are different claims.

## Empty states

Say what is absent and what causes it to appear.

> **No AI token usage recorded yet**  
> Usage appears after an agent session runs.

No-data is not the same as measured zero.

---

# 15. Tooltips and help

Native `title` is supplemental convenience.

It is useful for concise pointer help, especially on icon-only controls.

```html
<button
  class="k-iconbtn"
  aria-label="Refresh pull requests"
  title="Refresh pull requests"
>
  …
</button>
```

The accessible name comes from `aria-label`, not `title`.

Required guidance must not exist only in `title`.

For unavailable actions, use visible or associated explanation when the reason
matters:

```html
<button disabled aria-describedby="changesReason">Open changes</button>
<span id="changesReason">No worktree is available for this ticket</span>
```

Keep tooltip copy short and behavioral:

> Re-probe every PR for this ticket

not:

> Refresh button

---

# 16. Forms and overlays

Field errors belong to fields.

If a drawer/modal form can fail validation:

- keep it open until the result is known;
- retain entered values;
- identify the field;
- explain recovery.

Do not close the surface immediately after `post()` and then display the error
behind it.

Use a global error region only when there is no meaningful local owner.

---

# 17. Modal vs side panel

Visual similarity does not imply modal semantics.

## Modal drawer

Use when the user must finish/dismiss the overlay before interacting with the
underlying surface.

It follows the modal focus contract.

## Inspector / details panel

Use when users should move freely between the panel and main content.

It does not:

- trap focus;
- claim `aria-modal`;
- make the underlying UI inert.

---

# 18. Async feedback

The user should know when an action that visibly takes time was received.

The design system owns how pending/result state looks.

The application owns how the host and webview communicate that state.

## Pending

For an in-flight host mutation or long-running external operation whose result is
not immediately visible:

- show pending state;
- prevent unsafe duplicate activation;
- keep feedback scoped to the initiating control/surface.

## Success

Prefer the actual changed domain state as confirmation.

Use transient success feedback only when the changed state itself is not obvious.

## Failure

Put it where the user can act:

1. field/local surface;
2. workflow/state display;
3. toast when no better local home exists.

## Unknown

Timeout/lost acknowledgment does not prove failure.

It also does not prove the operation stopped.

Do not simply re-enable a destructive mutation and invite a duplicate retry
unless application architecture makes retry safe.

## Optimistic feedback

Do not call something "Saved", "Copied", "Merged", or equivalent when the
application can still determine that it failed.

If optimistic state is deliberately used for reversible UI behavior, represent it
as optimistic state with reconciliation—not false confirmed success.

---

# 19. Stable interaction geometry

Avoid needless movement when a control becomes busy or successful.

Even keeping the same label can cause reflow:

```text
Save
→ spinner + Save
→ check + Save
```

Solutions include:

- reserve an icon/status slot;
- preserve the control width;
- display status adjacent to the control;
- use the changed domain state instead of injecting a glyph.

The goal is stable geometry.

There is no blanket rule that text must never change.

---

# 20. Disabled state

Disabled means unavailable.

Loading means in progress.

They are not synonyms.

Native `disabled` is appropriate when removing the action from ordinary
interaction is correct.

If discoverability while unavailable is important, use an architecture that keeps
the explanation accessible rather than relying on a hover-only tooltip.

Do not double-dim components by blindly combining a faint semantic foreground and
global opacity if the resulting treatment loses useful structure.

Choose the disabled treatment at primitive level.

---

# 21. Local composition is allowed

The design system should make correct product UI easier.

It should not eliminate product design.

Legitimate local compositions include:

- stage rails;
- graph nodes and edges;
- implementation timelines;
- diff rows;
- repository grids;
- settings structures;
- usage visualizations;
- screen-specific headers.

Use shared semantic tokens and primitives where they genuinely fit.

Do not distort a composition merely to increase primitive reuse.

---

# 22. Host / presentation boundary

The host supplies semantic facts.

Example:

```ts
{
  status: 'running',
  stage: 'uat',
  canMerge: false
}
```

The webview decides how those facts are presented:

- class;
- glyph;
- token;
- component;
- local layout.

Do not send:

```ts
{
  className: 'green-pill',
  color: '#4bb64b'
}
```

from domain code.

## Formatting

Domain/canonical formatting remains upstream when it carries business meaning.

Pure display formatting may remain in the webview.

Ask:

> If another UI rendered this value differently, would the meaning change?

If yes, it is probably domain/canonical formatting.

If no, it may be presentation formatting.

---

# 23. Accessibility review

Prefer native HTML.

Do not treat a grep as proof of rendered accessibility.

Verify in the real webview:

- keyboard reachability;
- focus visibility;
- focus order;
- overlay focus behavior;
- accessible names;
- radio/switch keyboard behavior;
- light theme;
- dark theme;
- high contrast;
- color-independent status;
- reduced motion.

---

# 24. Working on a webview

1. Read the file's ownership/header notes.
2. Edit source, never generated `dist/`.
3. Preserve pinned mirrored behavior constants unless behavior change is explicitly
   in scope.
4. Escape untrusted values before interpolation.
5. Keep domain decisions out of CSS/presentation.
6. Keep CSS classes/colors out of host/domain view models.
7. Use static tests only for properties source inspection can prove.
8. Use runtime tests for behavior.
9. Use an F5/real-webview pass for rendered behavior.

---

# 25. Review checklist

- [ ] Approved compact visual character is preserved
- [ ] No incidental spacing/type/radius retuning
- [ ] Shared semantic controls use shared primitives
- [ ] Local compositions have not recreated an existing primitive
- [ ] Workflow, feedback, stage, selection, and chart-series meanings remain separate
- [ ] Repeated visual decisions use tokens
- [ ] Local layout geometry is clear rather than disguised as token arithmetic
- [ ] Actions are buttons; navigation/resource reveal is links
- [ ] Visible filepaths/PRs/commits are the link instead of duplicated Open buttons
- [ ] Rows with child actions avoid nested interactive controls
- [ ] Truly destructive actions use danger treatment
- [ ] Pending state exists where host/long-running operations visibly wait
- [ ] Unsafe duplicate activation is prevented
- [ ] Unknown is not shown as failed
- [ ] Retry is not offered blindly after uncertain destructive work
- [ ] Field errors stay with fields
- [ ] Required help does not depend on `title`
- [ ] Icon-only actions have accessible names
- [ ] Workflow status markers are icon-only with the correct glyph/color mapping
- [ ] Status remains understandable without color because glyphs differ
- [ ] Every displayed agent core is icon + canonical core name
- [ ] Model / effort / variant appear only when useful
- [ ] Focus is visible
- [ ] Normal text contrast is verified at the correct threshold
- [ ] Light, dark, and high-contrast themes are checked
- [ ] Shared/reusable components contain no hard-coded dark-theme surface leaks
- [ ] Reduced motion loses no information
- [ ] Mirrored behavior constants remain pinned
- [ ] Tests/typecheck pass
- [ ] Real webview verification covers what tests cannot prove
