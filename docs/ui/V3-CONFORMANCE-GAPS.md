# v3.0 conformance gaps — the replacement backlog

The v3.0 contract ([UI-RULES.md](./UI-RULES.md),
[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md), [STYLE-GUIDE.md](./STYLE-GUIDE.md))
describes the UI Karst is committing to. Parts of it are **not what is shipped
today**, and [REMEDIATION-PLAN.md](./REMEDIATION-PLAN.md) — the plan that closed
the previous contract — does not cover them.

This file is the list of known deltas, so the contract can be read as binding
without any of it silently reading as already true. Each entry names the shipped
state, the rule it fails, and what closing it costs. Nothing here was changed by
the ticket that adopted v3.0 (869egfk42) — that ticket replaced documents only.

**Status legend:** ☐ open · ☑ closed

---

## ☐ G1 — The workflow-status primitive is `.k-dot`, not `.k-status`

**Rule:** UI-R28 / UI-R28b, DESIGN-SYSTEM §11.12.

**Shipped:** `src/model/designComponents.ts` emits `.k-dot` — one filled circle
whose only per-state difference is `background`
(`--k-pending|running|attention|passed|failed`). Every state is the same shape,
so **hue is the only visible carrier** and the accessible name is what separates
them. v3.0 requires a distinct glyph per state (check / spinner / pause / cross /
neutral dot), which is exactly the non-color carrier `.k-dot` lacks.

**To close:** add `.k-status` with the five glyph variants (the running variant
reusing `.k-spinner`), migrate the `.k-dot` call sites, keep the accessible name
in real domain wording, and retire `.k-dot`. The catalog
([KARST-UI-CATALOG.html](./KARST-UI-CATALOG.html)) already renders the target.
Static test: state → glyph mapping; visual test: readable with color suppressed.

---

## ☐ G2 — `--k-success` aliases `--k-passed` in CSS

**Rule:** DESIGN-SYSTEM §2.2 / §3.5, UI-R05.

**Shipped:** `designTokens.ts` emits `'--k-success': 'var(--k-passed)'` (and
`--k-warning`→`--k-attention`, `--k-danger`→`--k-failed`,
`--k-info`→`--k-running`). v3.0 keeps the same rendered colors but forbids the
CSS alias: feedback and workflow status must source a shared value in
**TypeScript**, so "success feedback" never resolves *through* "workflow passed"
and either role can diverge without touching usage.

**To close:** hoist the four positive/attention/negative/neutral values to
private TS constants and emit both token families from them. Pure re-plumbing —
no rendered color changes, which is the point. Guard: a token test asserting no
`--k-*` feedback token's value textually references another public `--k-*` token.

---

## ☐ G3 — `--k-success-fg` / `--k-danger-fg` are the page background

**Rule:** DESIGN-SYSTEM §3.5, UI-R29.

**Shipped:** both resolve to `var(--vscode-editor-background)`. v3.0 says a
filled-surface foreground must not simply be the page background and must have a
pinned contrast test — a theme whose editor background sits close to the fill
gives unreadable text on a filled success/danger surface, and nothing currently
fails when it does.

**To close:** give each a Karst-owned concrete value beside the palette, and pin
the pair's contrast ratio in a test across light, dark and high-contrast.

---

## ☐ G4 — `/*KARST_PALETTE*/` is still a second delivery path

**Rule:** UI-R03, DESIGN-SYSTEM §1.2.

**Shipped:** `palette.ts` owns `PALETTE_MARKER` and webviews carry it in a
trailing `<style>` alongside the design-system markers; the feedback tokens
resolve through that ramp, so ordering is load-bearing (see the comment in
`designSystem.ts`). v3.0 permits this **during migration** and targets one
injection path.

**To close:** assemble the status/stage palette CSS into `injectDesignSystem`,
keep the cascade order, drop the marker and the `injectPalette` calls, and update
the webview discovery tests. Blocked behind G2 in practice — the alias is what
makes the ordering load-bearing.

---

## ☐ G5 — Secondary/metadata text below AA on the dashboard, sidebar, usage and resources

**Rule:** UI-R29, DESIGN-SYSTEM (`--k-text-dim` / `--k-text-faint` usage).

**Shipped:** the visual sweep's corpora for these views used to seed
MINIMAL/neutral state (empty panels, no stepper, no servers/worktrees/PRs —
`renderStateFor`), which never rendered the secondary/metadata text these
views actually carry in production. Once the corpora were switched to
populated production fixtures (`populatedStateFor`, `sidebarRenderFixtures`,
`usageRenderFixtures`, `resourcesRenderFixtures`),
`tests/visual/a11y.visual.ts`'s UI-R29 contrast sweep found this text —
labels, counts, timestamps, stage badges, step descriptions — sitting below
WCAG AA against its surface in dark and light themes (ratios observed
2.05–4.41; see `CONTRAST_RATCHET` entries tagged `gap: 'G5'`). This text was
already this dim; the corpus change only gave the sweep something to measure
it against for the first time. (gettingStarted's own G5 entries were a
different, now-closed defect — a missing `body` background, not dim text —
see below.)

**To close:** raise the `--k-text-dim` / `--k-text-faint` values (or the
specific component styles listed in the ratchet) until each pinned selector
clears 4.5:1 (3:1 for large text), then shrink `CONTRAST_RATCHET`
accordingly — the ratchet is shrink-only.

---

## ☑ gettingStarted is unreadable in the high-contrast theme (closed)

`src/ui/gettingStarted/webview.html`'s `body` rule set `color: var(--k-text)`
but, unlike every other webview, never set a `background` — so the page fell
back to the browser default (white) while `--k-text`/`--k-text-dim` resolve
to `#ffffff` under the harness's `hc` theme vars, collapsing body text to 1:1
contrast (confirmed in the old `hc/gettingStarted.png` baseline: only the
blue-linked controls, which source `--vscode-textLink-foreground`, stayed
visible). It also read white-on-white in `dark`, just less severely.

**Closed:** added `background: var(--k-bg)` to the `body` rule, matching
every other webview (UI-R05). The `hc`/`dark` `CONTRAST_RATCHET` entries this
caused (`h1`, `p.lede`, `h2`, `p.section-desc`, `button#dismiss`, and the
generic `dark:span`/`dark:div` G5 catches that were really this view's own
text) are removed from `tests/visual/a11y.visual.ts` now that the sweep
passes without them.

---

## Not gaps

- **`--k-passed` and `--k-success` rendering the same green** is intended
  (DESIGN-SYSTEM §3.5). Only the CSS alias is the defect (G2).
- **Local composition geometry outside the spacing scale** (stage rails, graphs,
  timelines) is permitted by v3.0 and is not remediation work.

---

## Known RUNTIME violations

Discovered by the jsdom render harness cross-view sweep
(`src/ui/runtimeConformance.render.test.ts`).  Each is a ratchet — the count
may only shrink.

| View | Rule | Count | Note |
|------|------|-------|------|
| dashboard | UI-R10 | 1 | `k-agent-core` class used on `#agentCore` but no CSSOM rule — styled via `.agent-identity` rules instead; the class is a hook for future theming |

All other views: **0** known unresolved `k-` class violations.
