# PLAN — Ship stage merge-conflict tracking

**Ticket**: `869e7bwaf` · Docs: [pm.md](./pm.md) · [ux.md](./ux.md) · [eng.md](./eng.md) · [research](../research/RESEARCH.md)

5 phases · 21 tasks · strict TDD (RED → GREEN) throughout.
Each phase leaves the tree green (`npm test` + `npm run typecheck`) and is independently committable.

---

## Phase 1 — Non-blocking git runner (prerequisite)

Must land first: Phase 3 adds a network `git fetch` to the ship path, and under today's `spawnSync` that freezes the extension host.

| # | Task | Complexity | Files |
|---|---|---|---|
| 1.1 | RED: test — `defaultGitRunner` leaves the event loop free while the child runs (mirror `gates/run.test.ts`) | Med | `src/integrations/git.test.ts` |
| 1.2 | RED: test — timeout kills the child, resolves `exitCode 1` + timeout reason | Low | same |
| 1.3 | GREEN: reimplement `defaultGitRunner` with async `spawn` + `GIT_TIMEOUT_MS` | Med | `src/integrations/git.ts` |
| 1.4 | Verify no call site changed (`GitRunner` type untouched); full suite green | Low | — |

**Done when**: `spawnSync` gone from `src/integrations/git.ts`; event-loop test passes; every existing git-dependent test still green.
**Depends on**: nothing.

---

## Phase 2 — Detection: `checkMergeable`

Pure over the injected `GitRunner`. No store, no ship, no vscode.

| # | Task | Complexity | Files |
|---|---|---|---|
| 2.1 | RED: exit 0 → `{state:'clean', files:[], reason:null}` | Low | `src/workflow/mergeCheck.test.ts` |
| 2.2 | RED: exit 1 → `conflicted` + parsed paths from `--name-only` | Med | same |
| 2.3 | RED: unknown paths — exit 128, spawn error, timeout, null `baseRef`, old-git `unknown option` | Med | same |
| 2.4 | RED: never throws; exit 1 with unparsable output stays `conflicted` with `files: []` | Low | same |
| 2.5 | GREEN: implement `checkMergeable(git, cwd, baseRef)` — fetch → rev-parse ×2 → `merge-tree --write-tree --name-only` | High | `src/workflow/mergeCheck.ts` (new) |

**Done when**: all three states reachable and asserted with a fake runner; no real repo/network touched.
**Depends on**: Phase 1 (uses the `GitRunner` contract; behaviourally independent, so 2.x can be written in parallel with 1.x).

---

## Phase 3 — Persistence: `merge_checks` (schema v9)

| # | Task | Complexity | Files |
|---|---|---|---|
| 3.1 | Add `merge_checks` DDL + intent comment (why NOT append-only) | Low | `src/store/schema.sql` |
| 3.2 | Guarded v9 step + no-backfill rationale comment; `SCHEMA_VERSION` 8→9 | Low | `src/store/migrations.ts` |
| 3.3 | RED: `db.test.ts` — `user_version` 9 everywhere, table count 10→11, `merge_checks` in `EXPECTED_TABLES`, v8→v9 upgrade test | Med | `src/store/db.test.ts` |
| 3.4 | RED: store tests — insert, upsert overwrites, JSON round-trip, malformed JSON → `[]`, per-repo isolation | Med | `src/store/mergeChecks.test.ts` (new) |
| 3.5 | GREEN: `setMergeCheck` (ON CONFLICT upsert) + `listMergeChecksByTicket`, driver-agnostic SQL | Med | `src/store/mergeChecks.ts` (new) |

**Done when**: fresh DB and a migrated v8 DB both carry `merge_checks`; upsert proven to overwrite (A4).
**Depends on**: nothing (schema work parallel to Phase 2). Ordered here because Phase 4 needs both.

---

## Phase 4 — Ship integration

| # | Task | Complexity | Files |
|---|---|---|---|
| 4.1 | RED: ship writes one `merge_checks` row per worktree, with a fake `GitRunner` | Med | `src/workflow/stages/ship.test.ts` |
| 4.2 | RED: a `conflicted` result does NOT fail the stage — ship still transitions to `done` (A6) | Med | same |
| 4.3 | RED: re-ship on the existing-open-PR path still refreshes the check (F4) | Med | same |
| 4.4 | RED: a `setMergeCheck` throw does not abort ship | Low | same |
| 4.5 | GREEN: call `checkMergeable` + `setMergeCheck` after `pushBranch`, **before** the `if (prior) continue` skip; guard the write | Med | `src/workflow/stages/ship.ts` |

**Done when**: every ship invocation leaves current mergeability for every hot repo, and no ship outcome changed.
**Depends on**: Phases 1, 2, 3.

---

## Phase 5 — Read paths

Every field optional; every renderer silent when absent → byte-identical output for pre-feature tickets (A5).

| # | Task | Complexity | Files |
|---|---|---|---|
| 5.1 | RED: `shipInside` renders clean / conflicted / unknown ops; renders nothing when no check | Med | `src/model/inside/*.test.ts` |
| 5.2 | GREEN: `StageInsideInput.mergeChecks?`; `shipInside` appends per-repo op (ux.md mapping, 5-path truncation) | Med | `src/model/inside/index.ts` |
| 5.3 | GREEN: load `mergeChecks` in dashboard state, pass through | Low | `src/ui/dashboard/state.ts` |
| 5.4 | RED: `renderTicketContext` suffixes `· merge: …` on the PR line for all three states; omits when absent | Med | `src/context/ticketContext.test.ts` |
| 5.5 | GREEN: `TicketContextPr.mergeCheck?`; join by repo in `buildTicketContext`; render in `renderTicketContext` | Med | `src/context/ticketContext.ts` |
| 5.6 | Verify the `karst context` CLI inherits it with zero CLI changes | Low | manual + existing CLI tests |
| 5.7 | Staleness: render `(stale)` where SHAs are already available; **no git call from any read path** | Med | `ticketContext.ts`, `inside/index.ts` |

**Done when**: all three surfaces show the state; no read path spawns a process.
**Depends on**: Phase 3 (types), Phase 4 (data to show).

---

## Dependency graph

```
Phase 1 ──┐
Phase 2 ──┼──► Phase 4 ──► Phase 5
Phase 3 ──┘
```

Phases 1, 2, 3 are mutually independent and can be built in any order.

## Validation gates

Per phase:
- [ ] Tests written RED first, observed failing, then GREEN
- [ ] `npm test` green
- [ ] `npm run typecheck` green
- [ ] Files under ~400 lines; no mutation; errors handled explicitly
- [ ] Conventional commit

Feature-complete gate — pm.md acceptance criteria:
- [ ] A1 conflicted + file list · A2 clean · A3 unknown-not-clean
- [ ] A4 upsert refresh · A5 no breaking change · A6 conflict doesn't fail ship
- [ ] `spawnSync` absent from `src/integrations/git.ts`
- [ ] Schema v9 on fresh + migrated DBs
- [ ] No backfill invented for pre-feature tickets

## Rollback

Each phase is a standalone commit. Phase 5 revert leaves data collected but unshown; Phase 4 revert stops collection; the v9 table is additive and inert if unused — no down-migration needed.
