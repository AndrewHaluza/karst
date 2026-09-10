# UI invariants (karst-specific rationale)

`docs/ui/UI-RULES.md` (v3.0) is the binding, numbered rule set and `docs/ui/DESIGN-SYSTEM.md` holds the tokens; this file holds the karst-specific reasoning and the incidents behind each rule, plus the two surface-naming invariants. Read `UI-RULES.md` before touching any webview.

## Contents

- The TITLE is a ticket's identity
- "Getting Started" names ONE surface
- Every UI change is judged pass/fail against UI-RULES.md
- Tokens carry the SHARED visual decisions
- The design system ships by marker injection
- Every control that posts to the host shows a pending state
- disabled and aria-busy are different states
- Pending feedback keeps the geometry stable
- Workflow status is ICON-ONLY
- An agent core is ALWAYS its canonical icon + canonical name
- Busy/result vocabularies are closed unions
- Semantics match the element
- A modal or drawer does not close before its action settles
- Product composition is allowed; only PRIMITIVES are shared
- Contrast is verified per theme
- Mirrored TS→HTML constants

## The TITLE is a ticket's identity; the key is derived from it

The ticket form gates Phase 2 on the title ALONE for every provider. A blank key resolves ONCE in `persistDraft` via `generateTicketKey(store, scope, title)` → `slugifyTitleKey` (`store/titleKey.ts`), suffixed `-2`, `-3`… in scope, falling back to `MANUAL-XXXXXXXX` only when the title has nothing key-able. `ticketForm/webview.html` mirrors that rule as `deriveKey`/`TITLE_KEY_MAX` and previews it live while the Key field is untouched (`refTouched`) — `webview.test.ts` pins the mirror, because a drift shows one key and stores another.

## "Getting Started" names ONE surface, and the ticket form is not it

`ui/gettingStarted/` is the fresh-install panel — setup checklist, tour, and the Report-an-issue entry — and it is what `karst.openGettingStarted` opens; `ui/ticketForm/` is the create/edit ticket page. The word "onboarding" is retired — a `grep -i onboarding` over `src/` must return ONLY the deprecated `karst.openOnboarding` alias and the comment explaining it. Three leftovers are deliberate and each is annotated where it lives: the `karst.welcomeDismissed` **workspaceState** key (persisted — renaming it re-opens the panel for everyone who already dismissed it), the `karst.openOnboarding` **command id** (externally consumable from a user's `keybindings.json`, so it stays registered, forwards to `karst.openTicketForm`, and is hidden from the palette via `menus.commandPalette`), and the dated design docs under `docs/superpowers/` + `docs/plans/00*`, which are a record of what was decided at the time and are not rewritten. Report-an-issue on that panel is a jump-off point, never a second reporting path: `GettingStartedActions.reportIssue` runs `karst.reportIssue` and nothing else.

## Every UI change is judged pass/fail against `docs/ui/UI-RULES.md` (v3.0)

It is numbered (`UI-R01`…), each rule carries a concrete Check AND a verification mode (STATIC / RUNTIME / VISUAL / REVIEW) — a grep is never accepted as proof of a rendered property. `docs/ui/DESIGN-SYSTEM.md` holds the tokens, primitives and the state vocabulary; `docs/ui/STYLE-GUIDE.md` holds naming, reuse and copy tone; `docs/ui/KARST-UI-CATALOG.html` is the rendered catalog of every primitive/state/token. Cite the rule id in the commit when a change exists to satisfy one (UI-R35). **Four parts of v3.0 are TARGET, not shipped** — the `.k-status` primitive, the no-CSS-alias rule for feedback tokens, the filled-surface foregrounds, and single-path palette delivery; they are enumerated in `docs/ui/V3-CONFORMANCE-GAPS.md` and none of them is a reason to write NEW code the old way.

## RUNTIME rules have a runner

The 18 RUNTIME-tagged rules (UI-R09, R11–R18, R22, R25–R27, R32, R33, R36, R37) now have a jsdom-based harness (`src/ui/testing/renderHarness.ts`) that hydrates any webview through the production injector chain, executes its inline script, and records `postMessage` round trips. The cross-view sweep (`src/ui/runtimeConformance.render.test.ts`) runs UI-R09, R10 (as rendered), R25, and R36 across all eight views; state-dependent rules are asserted for the dashboard only in `dashboard/render.render.test.ts` until FEAT-37 supplies the other corpora. The `render` vitest project (environment `jsdom`, pool `forks`) is required because jsdom's transitive `@exodus/bytes` ships ESM inside CJS and `vmThreads` cannot interop it. jsdom CSSOM limits apply: no `var()` resolution, no `calc()` evaluation, no layout, no real focus ring, no paint — anything needing those is VISUAL and belongs to FEAT-38.

## Tokens carry the SHARED visual decisions; local geometry stays local

(UI-R04/R05). Shared/repeated color, typography, spacing, radius, component sizing, elevation, motion and layering use `--k-*`. Screen-local composition geometry is legitimate and must NOT be disguised as `calc(var(--k-space-8) * 23)`. One MEANING has one definition — but semantic identity is not value identity: `--k-passed` and `--k-success` deliberately render the same green and stay separate tokens. v3.0 forbids the CSS ALIAS between them; `designTokens.ts` still emits `'--k-success': 'var(--k-passed)'` and three siblings, which is gap G2 — do not add a fifth. The status ramp (`model/palette.ts`) and stage ramp (`model/stagePalette.ts`) are CONSUMED, never redefined; workflow status, feedback, stage identity and chart series are four separate namespaces that never cross (UI-R06).

## Findings are ordered worst-first, capped after sorting, and repo-scoped

Findings are ordered worst-first by the host using one shared comparator (`model/severityOrder.ts`). The cap of 6 inside-block rows is applied AFTER the sort, so the worst findings survive it. The repo scope filters host-side for the inside block (bounded list — a client-side filter over an already-truncated list would lie about what exists) and webview-side for the Artifacts panel (complete list — no truncation, no lie). A finding with no recorded repo is shown only under "All" and never draws an empty repo cell. The severity ramp is defined once in `palette.ts` (`--k-sev-*` tokens) and consumed by both surfaces — a surface that maps a severity to a colour of its own is a defect.

## The design system ships by marker injection

`model/designSystem.ts` emits CSS+JS text swapped into `/*KARST_DS_CSS*/` (top of each `<style>`) and `/*KARST_DS_JS*/` (first statement in each `<script>`), before `injectCsp` nonces it. `ui/designSystem.test.ts` DISCOVERS the webview directories rather than listing them — a webview added later must not be able to ship outside the system silently. `/*KARST_PALETTE*/` is STILL LIVE and still load-bearing (it sits in the trailing `<style>` so the status ramp wins the cascade, and the feedback tokens alias onto it) — v3.0's single-injection path that retires it is gap G4, blocked behind G2, and until then a new webview carries the palette marker and its host call like every other one (UI-R03). No UI framework or component library is introduced (UI-R01).

## Every control that posts to the host shows a pending state, cannot be re-triggered, and reports a terminal outcome

(UI-R11–R14). `aria-busy` appeared ZERO times in the whole UI before this. Pending is set locally on click — not on the round trip. The single `routeAction`-shaped dispatch seam per webview emits one `{type:'action-result', requestId, ok, message?}`; action methods widened from `() => void` to `() => void | Promise<void>` so the dispatcher can await a real outcome. A watchdog is mandatory: a control may never be stuck pending, and its timeout reports "unknown", which is NOT the same claim as failure.

## `disabled` and `aria-busy` are different states

(UI-R17). Disabled = unavailable; busy = in flight. Never `pointer-events:none` to disable — it suppresses the tooltip that explains the disablement — and a REQUIRED explanation may never live only in a `title` (UI-R19): use visible or `aria-describedby` help. **A timeout is UNKNOWN, not failure** (UI-R14), and an uncertain non-idempotent mutation is not simply re-armed for a duplicate retry.

## Pending feedback keeps the geometry stable, not the label frozen

(UI-R18). Reserve an icon/status slot, pin a min-width, or put the status adjacent; a label change is allowed when deliberate and accessible — what is forbidden is a jump that moves the activation target or its neighbors, and needless accessible-name churn mid-action.

## Workflow status is ICON-ONLY

(UI-R28b): `.k-status` renders check / spinner / pause / cross / neutral dot — the primitive the code does NOT have yet (gap G1: `.k-dot` is one circle recolored per state, so hue is its only visible carrier) for passed·done / running / needs-attention·blocked / failed / pending, each with an accessible name in the real domain wording, and appends NO visible status word — the distinct glyph is the non-color carrier (UI-R28).

## An agent core is ALWAYS its canonical icon + canonical name

(UI-R10c), resolved through `model/providerIdentity.ts` from a semantic `agentCore` id the host supplies — never an `AI` badge, never a model name standing in for the core, never an icon alone. Model / effort / variant are subordinate metadata (`<icon> Codex · GPT-5.6 · high`). A core SELECTOR must render the same identity per choice, so a text-only native `<select>` of core names does not conform — use the radio/choice pattern.

## Busy/result vocabularies are closed unions, never `string`

(UI-R16). `TicketFormHostMessage` declared `{what: string}`, the host posted `what:'suggest'`, and the webview's switch had no case for it — so the Suggest button's pending state was silently swallowed. An unrecognized value is handled explicitly, not dropped.

## Semantics match the element

(UI-R09): an action is a `<button>`, navigation is an `<a href>`. A `<div>`/`<span>`/`<th>` with a click handler is a defect. **A visible resource identifier IS the link** (UI-R09c): a filepath, PR number or commit already on the row is the anchor (host-mediated reveal still keeps link semantics) — never inert text plus a duplicate `Open file` button. Interaction state (busy, pressed, disabled, success) belongs to the control that owns the action, never to the row containing it (UI-R09b). Icon-only controls MUST have an accessible name (UI-R24); a `title` is supplemental and, when both are present, must agree — same string preferred, ≤80 chars (UI-R20/R21). Destructive controls use the danger variant (UI-R10b) — judged by irreversible LOSS (delete, uninstall, destructive discard), not keyword: a reversible Archive is ordinary, and Merge is consequential-primary with its confirmation host-side.

## A modal or drawer does not close before its action settles

(UI-R14b). `settings`' approach drawer closed on the line after `post()`, so a host validation failure had nowhere to render and fell back to a global banner behind a closed drawer.

## Product composition is allowed; only PRIMITIVES are shared

(UI-R07/R08). Stage rails, graphs, timelines, diff rows, repo grids and usage visualizations stay LOCAL (unprefixed classes) — the rule is that a local class must never re-create an existing semantic primitive under another name. Karst's compact density is the approved baseline: spacing, type, radius and control heights are never retuned as incidental cleanup.

## Contrast is verified per theme, not assumed from theme variables

(UI-R29). Normal text ≥ 4.5:1 — a 14px `--k-text-lg` heading is NOT WCAG large text; a filled semantic surface's foreground must be a Karst-owned value with a pinned contrast test, never the page background — `--k-success-fg`/`--k-danger-fg` are `var(--vscode-editor-background)` today and that is gap G3, so use the PAIR and do not hand-pick a foreground beside it; and shared component CSS must not embed dark-theme literals that bypass the token layer. Check light, dark and high-contrast.

## Mirrored TS→HTML constants are BEHAVIOR, not styling

Mirrored TS→HTML constants (`SECTION_FIELDS`, `TICKET_TYPES`, `CONVENTION_PRESETS`, `TRANSFORM_NAMES`, `deriveKey`/`TITLE_KEY_MAX`, `MAX_PASTE_BYTES`, `briefToText`) are BEHAVIOR, not styling — a UI change must not touch them and their pinning tests must keep passing untouched (UI-R34).