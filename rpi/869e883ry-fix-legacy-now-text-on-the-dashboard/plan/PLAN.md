# PLAN — legacy Now text on the dashboard

**Ticket**: `869e883ry` · Docs: [pm.md](./pm.md) · [ux.md](./ux.md) · [eng.md](./eng.md) · [research](../research/RESEARCH.md)

5 phases · strict TDD (RED → GREEN) throughout. Each phase leaves the tree green (`npm test` + `npm run typecheck`) and is independently committable.

---

## Phase 1 — Gate stages: pending rows before the stage starts

Smallest, most isolated phase. No wire-format change, no webview change.

| # | Task | Complexity | Files |
|---|---|---|---|
| 1.1 | RED: `gateOp` returns a `pending` row for an unrecorded spec when the stage is `pending` (not just `running`) | Low | `src/model/inside/gates.test.ts` |
| 1.2 | RED: `reviewInside`/`uatInside` on a `pending` cell show gate-spec pending rows instead of falling to blurb | Med | same |
| 1.3 | RED: regression guard — `reviewInside` on a `pending` cell does NOT push a `pass`/`note` "diff" row (only `running`/finished may) | Med | same |
| 1.4 | GREEN: `gateOp` takes `showPending: boolean`; call sites pass `running || pending` | Low | `src/model/inside/gates.ts` |
| 1.5 | GREEN: decouple the `diff` row push from `ops.length` — gate strictly on `running` (note) / `finished` (pass) | Med | same |

**Done when**: a not-yet-started review/uat shows its gate list as pending; a not-yet-started review shows no diff row; all existing gates.test.ts cases still pass.
**Depends on**: nothing.

---

## Phase 2 — Ship model: pre-run predefined rows + structured step event type

Pure model-layer work, no ship.ts/webview wiring yet.

| # | Task | Complexity | Files |
|---|---|---|---|
| 2.1 | RED: `shipInside` on a `pending` cell with no PRs/mergeChecks yet emits one pending `pr` + one pending `merge` row per hot repo (from `selectedRepos`/`worktrees`), not blurb | Med | `src/model/inside/index.test.ts` |
| 2.2 | GREEN: implement the pending branch in `shipInside` | Low | `src/model/inside/index.ts` |
| 2.3 | Define `ShipStep`/`ShipStepEvent` types (commit, push, describe, pr, merge; status run/pass/note) | Low | `src/workflow/stages/ship.ts` |

**Done when**: a not-yet-started ship stage shows per-repo pending pr/merge rows; finished-state rendering (existing tests) unchanged.
**Depends on**: nothing (parallel to Phase 1).

---

## Phase 3 — Ship stage: structured progress events

Rewrites `ship.ts`'s progress emission. Highest-complexity phase — touches an existing 570-line test file's fakes throughout.

| # | Task | Complexity | Files |
|---|---|---|---|
| 3.1 | RED: `shipTicket` emits `{repo, step:'commit', status:'run'}` then `'pass'` bracketing `commitAllIfDirty`; same for `push`/`pushBranch` | Med | `src/workflow/stages/ship.test.ts` |
| 3.2 | RED: `describe` step only emitted when `adapter` is provided; `pr` step emitted around `findOpenPr`/`openPr` | Med | same |
| 3.3 | RED: the idempotent existing-PR-skip path (`if (prior) continue`) emits `note`-status event(s), never silently skips progress | Med | same |
| 3.4 | RED: `recordMergeChecks`'s per-worktree loop emits `{repo, step:'merge', status:'run'}` then a terminal status matching `mergeOpStatus(check.state)` | Med | same |
| 3.5 | GREEN: implement all of the above; delete the now-unused `tag()` helper and the old string-label calls | High | `src/workflow/stages/ship.ts` |
| 3.6 | Update `ShipProgress` call site in `extension.ts:739` and `panel.ts:postShipProgress` to the new event payload; rename the posted message field `label` → `event` | Low | `src/extension.ts`, `src/ui/dashboard/panel.ts` |

**Done when**: every existing ship.ts behavior/test still passes with the new event shape; no test still constructs a string-label fake `onProgress`.
**Depends on**: Phase 2 (needs `ShipStepEvent` type).

---

## Phase 4 — Webview: live ops in `#inside`, real Now-line sentence

| # | Task | Complexity | Files |
|---|---|---|---|
| 4.1 | Extract a pure function `mergeShipOps(repos, events) → StageOp[]` (ordered commit/push/describe/pr/merge per repo) so it's testable outside the DOM | Med | `src/ui/dashboard/webview.html` |
| 4.2 | On "Confirm ship" click: seed `shipOps` with every hot repo × step at `pending` (from `state.worktrees`), same instant-feedback timing as today | Low | same |
| 4.3 | On `{type:'ship-progress', event}`: update `shipOps`, re-render | Low | same |
| 4.4 | In `render()`: when `shipping` and `sel==='ship'`, pass a `StageInside` built from `mergeShipOps` into `renderInside` instead of `state.inside.ship` | Med | same |
| 4.5 | Delete `renderShipProgress()` and its call from `renderNow()`; Now line always renders `state.now.text` | Low | same |
| 4.6 | RED+GREEN: `nowLine.ts` — add the `cell.status === 'running'` ship case ("Now: shipping — …"), no action | Low | `src/model/nowLine.ts`, `src/model/nowLine.test.ts` |
| 4.7 | Manual verify: F5 extension dev host, ship a real/fake worktree, confirm Inside block updates live, Now line stays static, `shipDone` flash still fires on success | — | manual |

**Done when**: watching a real ship in the Extension Dev Host shows live per-step Inside rows, no `#now` narration, and the finished/failed states are pixel-identical to before.
**Depends on**: Phase 3 (event shape must exist), Phase 2 (pre-run rows).

---

## Phase 5 — Full-lifecycle regression pass

| # | Task | Complexity | Files |
|---|---|---|---|
| 5.1 | Re-run full suite + typecheck | Low | — |
| 5.2 | Walk pm.md's 6 acceptance criteria against the running extension (Dev Host) | Low | manual |
| 5.3 | Confirm no other stage (`scope`/`impl`/`uat`/`review`/`fix`/`done`) regressed — diff `renderInside` output isn't reachable via automated snapshot (no such harness exists today), so this is a manual click-through per stage | Low | manual |

**Done when**: every stage's Inside block renders correctly across not-started/running/finished; ship's three-system text problem from the ticket is gone.
**Depends on**: Phases 1-4.

---

## Dependency graph

```
Phase 1 ─┐
Phase 2 ─┼──► Phase 3 ──► Phase 4 ──► Phase 5
```
Phases 1 and 2 are mutually independent and can be built/committed in either order.

## Validation gates

Per phase:
- [ ] Tests written RED first, observed failing, then GREEN
- [ ] `npm test` green
- [ ] `npm run typecheck` green
- [ ] Files under ~400 lines (webview.html is already 859 — this ticket only edits it, doesn't need to split it); no mutation; errors handled explicitly
- [ ] Conventional commit

Feature-complete gate — pm.md acceptance criteria:
- [ ] Ship pending: per-repo pr/merge pending rows, no blurb
- [ ] Ship running: live per-step Inside rows; Now line is a plain sentence, no button, no step narration
- [ ] Ship finished: byte-identical to today
- [ ] Review/UAT pending: gate-list pending rows, no blurb
- [ ] `impl`/`fix` unchanged (still blurb before running — intentional)
- [ ] Zero regressions in existing dashboard/ship/gates/nowLine test suites

## Rollback

Each phase is a standalone commit. Phase 4 revert restores the old `ship-progress`/Now-line hijack (Phase 3's event shape is additive-compatible with a string fallback if needed, but reverting cleanly just reverts 3+4 together since panel.ts's message shape changed). Phases 1-2 are additive-only (new pending-row branches) and safe to revert independently.
