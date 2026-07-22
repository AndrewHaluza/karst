# Implementation Record

**Feature**: 869e883ry-fix-legacy-now-text-on-the-dashboard
**Status**: COMPLETED

## Phase 1 — Gate stages: pending rows before the stage starts

**Verdict**: PASS

`gateOp`/`gateOps` (`src/model/inside/gates.ts`) now synthesize `pending` rows before a stage starts running, not just while running, sourced from `REVIEW_GATES`/`UAT_GATE`. Decoupled the trailing `diff` row from `ops.length` (was firing a false "opened for review" row on any finished stage with zero own-evidence rows) — now gated on `running || (finished && ops.length > 0)`.

Files: `src/model/inside/gates.ts`, `src/model/inside/gates.test.ts`, `src/model/inside/index.test.ts` (updated the blanket "no stage shows rows before it's run" test to exempt review/uat).

## Phase 2 — Ship model: pre-run predefined rows

**Verdict**: PASS

`shipInside` (`src/model/inside/index.ts`) synthesizes pending `pr`/`merge` rows per hot repo (from `selectedRepos`) when ship is `pending` with no PRs yet, instead of falling to blurb.

Files: `src/model/inside/index.ts`, `src/model/inside/index.test.ts`.

## Phase 3 — Ship stage: structured progress events

**Verdict**: PASS (post-review fix applied)

`ShipProgress` changed from `(label: string) => void` to `(event: ShipStepEvent) => void`, `ShipStepEvent = { repo, step, status, detail? }`. Every await bracketed with run/pass events. Merge-check loop emits per-repo run/terminal events matching `mergeOpStatus`. Idempotent-skip path (PR already open) emits `note` events — **initially only for the `pr` step; code review (MEDIUM) flagged that commit/push were left looking like pending "still to come" work that structurally cannot happen — fixed to emit `note` for every skipped step** (commit, push, describe if adapter, pr).

Files: `src/workflow/stages/ship.ts`, `src/workflow/stages/ship.test.ts`.

## Phase 4 — Webview + Now line

**Verdict**: PASS (post-review fix applied)

`nowLine.ts` ship case: added `running` branch with a static "Now: shipping — …" sentence, no button. Webview: removed `shipLabel`/`renderShipProgress()` (the Now-line hijack); added `shipOps`/`seedShipOps`/`flattenShipOps`/`shippingView()` overlaying live per-step state onto `state.inside.ship.ops` before the existing shared `renderInside()`. **Code review (LOW) flagged that a host-supplied `detail` string could silently replace the repo name in the overlay on a multi-repo ship, making two repos' note rows indistinguishable — fixed by prefixing with the repo name when more than one worktree is shipping.**

Files: `src/model/nowLine.ts`, `src/model/nowLine.test.ts`, `src/ui/dashboard/webview.html`, `src/ui/dashboard/webview.test.ts`, `src/extension.ts`, `src/ui/dashboard/panel.ts`, `src/ui/dashboard/panel.test.ts`.

## Phase 5 — Regression pass

**Verdict**: PASS

Full suite: 142 test files / 1691 tests green. `npm run typecheck` clean. `npm run build` (compile + asset copy) clean. Manual F5 click-through in the Extension Dev Host was not performed in this session (no interactive VS Code session available) — recommended before merge if the change is user-facing-sensitive.

## Code Review

Agent: code-reviewer. Verdict: APPROVE. 0 CRITICAL, 0 HIGH, 1 MEDIUM (fixed), 1 LOW (fixed). Both findings addressed above; full suite re-verified green after fixes.

## Summary

**Phases Completed**: 5 of 5
**Final Status**: COMPLETED
