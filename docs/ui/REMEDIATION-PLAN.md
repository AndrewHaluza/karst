# UI Remediation Plan — 869eckg0u

Bringing the existing UI into conformance with [UI-RULES.md](./UI-RULES.md).
Every task names the rules it satisfies, so the work is traceable back to the
contract (UI-R35).

> **Contract superseded — read the rules, not this plan, for what is binding.**
> The contract was replaced by v3.0 (`UI-RULES.md`, `DESIGN-SYSTEM.md`,
> `STYLE-GUIDE.md`, `KARST-UI-CATALOG.html`). The rule numbering and the phase
> ticks below are a record of the earlier remediation, not the current rule set:
> v3.0 renumbers to `UI-R01`…`UI-R37` (plus `R09b`/`R09c`/`R10b`/`R10c`/`R14b`/
> `R28b`), adds verification modes, and changes several rulings (icon-only
> status, agent-core identity, resource-identifier links, geometry-stable
> pending instead of frozen labels, local geometry allowed outside the token
> scale). Where this plan and v3.0 disagree, v3.0 wins.
>
> The work v3.0 adds on top of what this plan already closed is tracked in
> [V3-CONFORMANCE-GAPS.md](./V3-CONFORMANCE-GAPS.md) — read that for what is
> still open, not the ticks below.

**Status legend:** ☑ done · ☐ pending

---

## Phase 0 — Contract (☑ done)

| # | Deliverable | Rules |
|---|---|---|
| ☑ 0.1 | `docs/ui/UI-RULES.md` — 39 numbered, checkable rules | — |
| ☑ 0.2 | `docs/ui/DESIGN-SYSTEM.md` — tokens, primitives, state matrix, async contract, a11y baseline | — |
| ☑ 0.3 | `docs/ui/STYLE-GUIDE.md` — naming, reuse, copy tone, do/don't | — |
| ☑ 0.4 | Binding section in `CLAUDE.md` **and** `AGENTS.md` | UI-R01 |

## Phase 1 — Infrastructure (☑ done)

| # | Deliverable | Rules | Tests |
|---|---|---|---|
| ☑ 1.1 | `src/model/designTokens.ts` — 80 tokens; one meaning ⇒ one token; one variable ⇒ one fallback | R04, R05, R06 | 9 |
| ☑ 1.2 | `src/model/designComponents.ts` — 12 primitives, full state matrix, token-only, reduced motion | R07, R10, R10b, R23, R30 | 14 |
| ☑ 1.3 | `src/model/designRuntime.ts` — pending / non-re-trigger / terminal result / watchdog / capped toast | R11–R18, R27, R32 | 15 |
| ☑ 1.4 | `src/model/designSystem.ts` + markers in all 7 webviews + 7 host call sites | R02, R03 | 45 |

Baseline before: 243 files / 3357 tests. After Phase 1: **247 / 3440**, all green.

---

## Phase 2 — Host async contract (☑ done)

The blocker for R13 on every screen. Do this **before** any screen remediation:
a screen cannot report a terminal outcome that the host has no way to send.

| # | Task | Rules |
|---|---|---|
| ☑ 2.1 | `src/model/actionResult.ts` — shared `{type:'action-result', requestId, ok, message?}` type + `settleFrom(dispatch)` helper that wraps a `routeAction`-shaped seam, awaits a returned thenable, and posts exactly one result. One-line message cap reused from the runtime's rule. | R13, R32 |
| ☑ 2.2 | Widen action interfaces from `() => void` to `() => void \| Promise<void>` in all 7 `messages.ts`. A **type widening** — every existing implementation still satisfies it, and one that keeps returning `void` keeps its exact current semantics. | R13, R37 |
| ☑ 2.3 | Add `action-result` to each of the 7 host-message unions; emit from the single dispatch seam per webview, never per call site. | R13 |
| ☑ 2.4 | Close the `busy` vocabulary in `ticketForm/messages.ts` (`what: string` → union) **and fix the swallowed `'suggest'` case** — a live defect: the host posts it, the webview's switch has no branch, so Suggest never shows pending. | R16 |
| ☑ 2.5 | Give `sidebar` and `usage` a host→webview channel at all — both are `{type:'state'}` only today, so `spin`/`archive`/`delete` have no way to report anything. | R13 |

**Verification:** unit tests per seam — one result per parsed request, a rejected promise reports `ok:false`, a `void` return acks, an unparsed message posts nothing.

---

## Phase 3 — Screen remediation (☑ 7 of 7 complete)

One task per webview, each independently verifiable. Ordered by
(risk × traffic), lowest first, so the pattern is proven on small surfaces
before it reaches the 3127-line file.

Every screen task is the same shape:

1. Replace the file's `:root` block with the injected tokens; delete every local
   duplicate. (R04, R05)
2. Replace every button/input/chip/dot with the `k-` primitive + variant; delete
   the local restyling. (R07, R08, R10)
3. Route every host-posting control through `karstAction`. (R11–R14, R18)
4. Fix element semantics — every click target a `<button>`/`<a href>`. (R09)
5. Add `aria-label`+`title` pairs, `aria-expanded`/`pressed`/`checked`/`invalid`,
   labels for inputs. (R19–R21, R24–R26)
6. Danger variant on every destructive control. (R10b)
7. Extend the file's `webview.test.ts` with the new guards; leave mirrored
   constants and their pinning tests untouched. (R34, R36)

| # | Screen | Lines | Controls | Screen-specific defects to fix |
|---|---|---|---|---|
| ☑ 3.1 | `welcome` | 155 | 4 | Only file in `rem`; **no** `:root`; no `:focus-visible` anywhere; no `title` anywhere; `create-manifest` writes to disk un-disabled during the await; `.mark` ✓/✗ unlabelled; `#error` not a live region |
| ☑ 3.2 | `usage` | 300 | 6 | `th[data-sort]` click handler, **no keyboard path at all**; `#err`/`#empty` not live regions; `.ranges button` is a second, unrelated implementation of `sidebar`'s facet chip |
| ☑ 3.3 | `diffs` | 524 | 7 | `.file` and `.copy-hash` each de-style a `<button>` into something unrecognizable; A/M/D/R carried by colour + bare letter; optimistic copy is legitimate — keep it, and **comment it as optimistic** (R15) |
| ☑ 3.4 | `sidebar` | 355 | 13 | `.chev` `<span>` and `.row` `<div>` click targets; `#emptyNew` `<a>` with no `href`; **no** `:focus-visible` anywhere; every `.ia` icon button lacks `aria-label`; `spin`/`archive`/`delete` fire-and-forget; `.tool` and `.ia` are two icon buttons in one file |
| ☑ 3.5 | `ticketForm` | 1361 | ~30 | `.ghost` class with no rule; `#detailsBtn` no `aria-expanded`; `.chip`/`.acard` non-native with no `aria-pressed`/`aria-checked`; stepper has no `aria-current`; `#sig-*` inputs unlabelled; attach/paste/detach have no pending UI during file I/O; one shared `#err` for every failure |
| ☑ 3.6 | `dashboard` | 1578 | ~28 | Three ad-hoc pending booleans to replace; `mergePending` cleared identically on success, refusal and cancel; no live region; `#8957e5`/`#a371f7`/`#8a63d2` three purples; `background:#8957e5;color:#fff` unpaired; fix-node button has neither `title` nor `aria-label` |
| ☑ 3.7 | `settings` | 3127 | ~44 | **No danger variant at all** — Delete/Remove/Uninstall look like Cancel; `.card-head` accordion is a `<div>`, unreachable by keyboard; approach drawer closes before the ack (R14b); `save-agent-file` has no `saved` ack; double-click Save sends two saves; `--chevron` data URI bakes a non-themeable `%238a8a8a`; provider listbox has no arrow-key navigation |

---

## Status

All seven screens are remediated and the contract is enforced by a
discovery-based conformance suite (`src/ui/conformance.test.ts`).

`npm test` → **250 files / 3664 tests**, `npm run typecheck` clean.
Baseline before this ticket: 243 files / 3357 tests (**+307 tests**).

### Documented exceptions

Two raw literals survive, both with no token form available:

| Where | Literal | Why it stands |
|---|---|---|
| `diffs` | `@media (max-width: 440px)` | a CSS media condition cannot read a custom property |
| `settings` | `%238a8a8a` in the `--chevron` data URI | a data URI cannot resolve a CSS variable |

`dashboard` additionally carries 10 one-off component dimensions with no step on
the closed spacing scale, each commented in place. All of these are held by a
**ratchet** in `conformance.test.ts` (`LITERAL_BUDGET`): the count may never grow,
and driving it to zero means deliberately adding tokens rather than letting an
edit smuggle one in.

### Known limitation

**A merge refusal and a cancelled confirmation are still indistinguishable in the
panel.** `extension.ts`'s `mergePr` runs fire-and-forget, so the webview settles
from the next `state` push and can only ask "did the PR end up merged". Success
is real; anything else settles `null` (unknown) — never a false "failed", which
is the honest reading. gh's own words still reach the user through a native error
dialog. A true three-way distinction needs `mergePr` to report over a channel the
webview can read, which is a behaviour change beyond this ticket's scope (R37).

---

## Phase 4 — Verification (☐)

| # | Task | Rules |
|---|---|---|
| ☑ 4.1 | `src/ui/conformance.test.ts` — discovery-based, runs the rule **Checks** across every webview: no hex/`rgba`/raw length outside tokens, every icon-only control has matching `aria-label`+`title`, every `title` ≤80 chars, no click handler on a non-interactive element, no `pointer-events:none` | R04, R09, R19–R21, R24 |
| ☐ 4.2 | Contrast audit of the token pairs against the default dark and light themes | R29 |
| ☐ 4.3 | Manual F5 pass — focus order, real spinners, real keyboard operation. Text-level tests cannot see these. | R23, R36 |
| ☐ 4.4 | `npm test` + `npm run typecheck` green; mirrored-constant pinning tests untouched | R34, R37 |

---

## Out of scope

- Any change to what an action **does**, which message it posts, what the host
  executes, or what is persisted (R37). This is presentation and
  interaction-feedback only.
- Re-theming: values resolve to the user's VS Code theme and must keep doing so.
- The status ramp and stage ramp — consumed, never redefined (R06).
