# Karst UI Style Guide

How to *apply* the [design system](./DESIGN-SYSTEM.md). The
[rules](./UI-RULES.md) say what is mandatory; this says what is good.

---

## 1. Naming

### CSS

| Kind | Convention | Example |
|---|---|---|
| Primitive | `.k-<noun>` | `.k-btn`, `.k-chip`, `.k-toast` |
| Variant | `.k-<noun>--<variant>` | `.k-btn--danger`, `.k-toast--error` |
| Size | `.k-<noun>--<size>` | `.k-btn--sm` |
| State (runtime) | `.is-<state>` | `.is-success`, `.is-open` |
| Screen-local layout | plain, unprefixed | `.stepper`, `.uhead`, `.rowacts` |

The `k-` prefix marks "this is shared and you may not restyle it". An unprefixed
class is screen-local layout and may be anything, as long as it sets only layout
properties — position, size, grid/flex placement — never appearance.

### Tokens

`--k-<category>-<name>[-<modifier>]`: `--k-space-4`, `--k-text-dim`,
`--k-action-bg-hover`, `--k-dur-fast`.

Name for **meaning**, never for value or appearance. `--k-danger`, not `--k-red`;
`--k-space-4`, not `--k-space-8px`. A token named for its value is a token that
can never change.

### JS in webviews

`camelCase`; `post()` for the message sender; `el(id)` for lookup; `esc()` for
escaping. Keep these names — they are the same in all seven files, and that
consistency is why a reader can move between them.

---

## 2. Reuse vs. new component

Decide in this order:

1. **Does a primitive already fit?** Use it. A visual difference you were about
   to add is probably not load-bearing.
2. **Does a primitive fit with a new variant?** Add the variant to
   `designSystem.ts` and to the design system doc. A variant is justified when it
   encodes a *different meaning* (danger, secondary), not a different taste.
3. **Is it a one-screen layout arrangement of primitives?** Build it locally with
   an unprefixed class. Do not promote it.
4. **Is it a genuinely new interaction that will appear on ≥2 screens?** Then it
   is a new primitive: add it to `designSystem.ts`, document its full state
   matrix, and test it.

> A new primitive that exists on one screen is a local component wearing a `k-`
> prefix. It costs everyone the review of a shared API and buys nothing.

### Signs you are about to duplicate something

- You are writing `background`, `border`, `padding`, `border-radius`, or
  `font-size` on a `<button>`.
- You are about to pick a hex.
- You are naming something `.btn2`, `.smallbtn`, `.actionButton`.
- You are copying a rule out of another `webview.html`. **That is how the six
  greens happened.** Every one of them started as a reasonable local choice.

---

## 3. Copy tone

Karst talks like a competent colleague: direct, specific, never cheerful about
failure and never vague about it either.

### Labels

- Imperative verb + object: **Create ticket**, **Resolve conflicts**, **Open log**.
- Sentence case. Not Title Case, not ALL CAPS (uppercase is a *style*, via
  `text-transform`, not a way of writing the string).
- No trailing punctuation. No ellipsis except where the control genuinely opens a
  further choice (**Attach…**, **Switch agent…**).
- Name the object when the screen shows more than one thing it could apply to:
  **Open PR**, not **Open**.

### Tooltips

- ≤ 80 characters, one sentence, no trailing period.
- Say what happens: *"Re-probe every PR for this ticket"*.
- Never restate the label: a button reading **Archive** does not need
  `title="Archive"`.
- On a disabled control, say **why**: *"No worktree to show changes for"*.

### Errors

Three parts, in order — **what failed · why · what to do**:

> Could not refresh ticket changes: worktree is missing. Re-spin the ticket.

- Address the user as "you" only when they must act. Never blame them.
- Never surface a raw exception, stack, or multi-kilobyte CLI envelope. Collapse
  to one line and cap it (UI-R32) — a 429 JSON blob read as an internal crash
  once already.
- "Unknown" is a legitimate outcome and must be worded as itself, not as failure
  (UI-R14). *"Still running — result unknown"* ≠ *"Failed"*.

### Empty states

Name what is absent, then the next action:

> **No AI token usage recorded yet**
> Usage is recorded when an agent session runs.

Never render zeros for absence. `0` asserts a measurement; absence is a different
claim.

---

## 4. Do / Don't

### Colour

```css
/* DON'T — a sixth green, and a foreground picked against a themed background */
.badge-ok { background: #2ea043; color: #fff; }

/* DO — one meaning, one token, a paired foreground */
.badge-ok { background: var(--k-success); color: var(--k-success-fg); }
```

```css
/* DON'T — same variable, a different fallback per file */
/* diffs:   */ color: var(--vscode-testing-iconPassed, #73c991);
/* welcome: */ color: var(--vscode-testing-iconPassed, #3fb950);

/* DO — the fallback is decided once, in designSystem.ts */
color: var(--k-success);
```

### Spacing and type

```css
/* DON'T — off-scale values that read as precision but are rounding noise */
.meta { font-size: 10.5px; padding: 7px 13px; gap: 9px; }

/* DO */
.meta { font-size: var(--k-text-2xs); padding: var(--k-space-3) var(--k-space-6); gap: var(--k-space-4); }
```

### Buttons

```html
<!-- DON'T — a class with no rule, so it silently renders as primary -->
<button id="attachBtn" class="ghost">Attach…</button>

<!-- DO -->
<button id="attachBtn" class="k-btn k-btn--ghost">Attach…</button>
```

```css
/* DON'T — restyling the primitive back into a bespoke control */
.file { border: 0; border-radius: 0; background: none; text-align: left; }

/* DO — a variant that exists, plus local layout only */
.file { /* grid placement only */ }
```

### Semantics

```html
<!-- DON'T — a click handler on a th: unreachable by keyboard -->
<th data-sort="total" class="sortable">Total</th>

<!-- DO -->
<th aria-sort="descending"><button class="k-btn--link" data-sort="total">Total</button></th>
```

```html
<!-- DON'T -->
<span class="chev" data-toggle></span>
<div class="row" data-open></div>

<!-- DO -->
<button class="k-iconbtn" data-toggle aria-expanded="false" aria-label="Expand ticket" title="Expand ticket">…</button>
```

### Async feedback

```js
// DON'T — fire and forget: nothing tells the user this was even received
btn.addEventListener('click', () => post({ type: 'archive', ticketId: id }));

// DO — pending on click, non-re-triggerable, settles on the host's result
karstAction(btn, () => post({ type: 'archive', ticketId: id, requestId: rid() }));
```

```js
// DON'T — the accessible name changes mid-action and the control reflows
btn.textContent = 'Saving…';

// DO — the label is stable; the spinner carries the meaning
// (handled by the runtime: aria-busy + disabled + .k-spinner)
```

```js
// DON'T — optimistic success on a mutation
post({ type: 'merge-pr', repo }); flashOk(btn);

// DO — optimistic only where failure needs no user action, and say so
// Optimistic: the host does the clipboard write; a failed copy is recoverable
// by clicking again, so we do not wait for confirmation. (UI-R15)
post({ type: 'copy-hash', hash }); flashCopied(btn);
```

### Icon-only controls

```html
<!-- DON'T — title is not an accessible name -->
<button class="ia" data-act="delete" title="Delete"><svg …></svg></button>

<!-- DO — same string in both, and a variant that marks it destructive -->
<button class="k-iconbtn k-iconbtn--danger" data-act="delete"
        aria-label="Delete ticket permanently" title="Delete ticket permanently">
  <svg aria-hidden="true" …></svg>
</button>
```

---

## 5. Working on a webview

1. **Read the file's header comment first.** Each webview states what it decides
   and what it does not. Most decide nothing — that is deliberate (UI-R31).
2. **Never edit `dist/`.** Edit `src/ui/<name>/webview.html`;
   `scripts/copy-assets.mjs` mirrors it.
3. **Mirrored constants are behaviour** (UI-R34). If you are reformatting near
   `deriveKey`, `MAX_PASTE_BYTES`, `SECTION_FIELDS`, `TRANSFORM_NAMES`,
   `briefToText`, or `CONVENTION_PRESETS`, stop and leave them exactly as they are.
4. **Escape everything interpolated.** `esc()` on every value that reaches HTML.
   CSP is the backstop, not the guard.
5. **Text-level tests are the harness.** There is no DOM in vitest. Assert on the
   HTML string; test real behaviour in the emitted runtime against a fake DOM.
6. **F5 is still required** for anything a string match cannot see — a broken
   `calc()`, a mistyped class, a focus order.

---

## 6. Review checklist

Before calling UI work done:

- [ ] No hex, `rgba()`, raw `px`/`rem`, raw radius, raw duration in the diff (UI-R04)
- [ ] Every button is a `.k-btn`/`.k-iconbtn` variant; nothing restyles a primitive (UI-R07)
- [ ] Every async control: pending on click, non-re-triggerable, terminal result, watchdog (UI-R11–R14)
- [ ] Every icon-only control: matching `aria-label` + `title`, ≤80 chars (UI-R19–R21, R24)
- [ ] Every click target is a `<button>` or `<a href>` (UI-R09)
- [ ] `aria-busy` / `aria-expanded` / `aria-pressed` / `aria-checked` / `aria-invalid` reflect real state (UI-R26)
- [ ] One live region, and results reach it (UI-R27)
- [ ] Keyboard: reachable, operable, visible focus (UI-R09, R23)
- [ ] Reduced motion loses no information (UI-R30)
- [ ] Mirrored constants untouched and still pinned (UI-R34)
- [ ] Commit cites the rule ids (UI-R35)
- [ ] `npm test` and `npm run typecheck` pass (UI-R37)
