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

## Not gaps

- **`--k-passed` and `--k-success` rendering the same green** is intended
  (DESIGN-SYSTEM §3.5). Only the CSS alias is the defect (G2).
- **Local composition geometry outside the spacing scale** (stage rails, graphs,
  timelines) is permitted by v3.0 and is not remediation work.
