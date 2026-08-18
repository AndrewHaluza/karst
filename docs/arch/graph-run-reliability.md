# Dynamic graph: why runs do not complete consistently

Field evidence, registry `karst.db`, 2026-08-18. Seven graph runs of
`karst-graph-engineering` exist. Two closed. Five did not.

| run | ticket | status | terminal reason |
|-----|--------|--------|-----------------|
| 1 | 339 | blocked | `launch-unknown: node 1 crashed after a possible spawn with no identity` |
| 2 | 352 | closed | — |
| 3 | 356 | blocked | `node-blocked: node 3 process (pid 50041) is gone (dead at reconcile)` |
| 4 | 360 | draining | none — stuck in `draining` since 2026-08-16 |
| 5 | 363 | blocked | `graph-plan-invalid: reserved-identifier: entries[0]: "$entry" is a reserved sentinel` |
| 6 | 364 | closed | — |
| 7 | 366 | blocked | `graph-plan-invalid: unknown-repository: implement-setup: node "implement-setup" claims unknown repository "extention"` |

Completion rate 2/7. Every failure below is a gap in the run loop, not in the
plan the agent wrote.

## G1 — the compile judges a plan against whatever manifest the sweeping window holds

`graphCompileContext` (`src/extension.ts`) builds its `repositories` map from
`currentManifest()` of the window running the tick, intersected with
`listWorktreesByTicket`. Neither the periodic coordinator sweep nor the
reconcile pass is project-scoped:

- `activeGraphRunIds(db)` (`coordinator/sweep.ts:507`) selects **every**
  `status='running'` run in the registry — the registry is shared by every IDE
  window (see `docs/arch/store-and-schema.md`).
- `reconcileGraphRuns` (`src/extension.ts:4502`) selects **every row** of
  `approach_graph_runs`, with no project scope and no status filter, and calls
  `driveGraphRunContinuation` on each — closed and blocked runs included.

So a window open on project B ticks project A's run and compiles A's plan
against B's manifest. Every repository name in the plan is then unknown.
`unknown-repository: "extention"` is exactly that shape: `extention` **is** a
declared repository of the karst manifest, the ticket's worktree row exists,
and the ticket context handed to the planner names it. The plan was correct;
the judge held the wrong manifest.

The same hole exists when the manifest simply is not loaded yet:
`currentManifest() ?? emptyManifest()` yields an empty repository map, and the
compile rejects a valid plan rather than declining to judge it.

**A plan must never be judged against an unresolved or foreign manifest.**

## G2 — plan rejection is terminal on the first attempt

`compileWithRepair` (`coordinator/repair.ts`) implements the intended contract:
a rejected document returns to the SAME planner run with the compiler's
structured diagnostics as input, three attempts, no extra budget charged.

It is never called. `grep compileWithRepair src` outside its own test file
returns nothing. The live path is `acceptSubmittedPlan` →`blockInvalidPlan`
(`driver.ts:757`), which blocks the run on attempt one. The registry confirms
it: `compile_attempt` is `0` on all ten planner runs ever recorded.

Consequence: the planner gets one shot at a document format it cannot fully
observe, and a single diagnostic ends the run.

## G3 — the diagnostics are written where nothing reads them

`blockInvalidPlan` writes `diagnostics/planner-<id>.json` beside the snapshot.
No code path ever reads that file back. The graph-aware Resume maps
`graph-plan-invalid` → `replan` (`coordinator/recovery.ts:209`), and
`launchReplanPlannerHost` composes the replan prompt from the base SKILL, the
ticket context and the replan reasons — never the compile diagnostics. A manual
Resume therefore re-runs a planner that has not been told what was wrong, and
the most likely outcome is the same invalid document.

## G4 — the graph sweep rides the GitHub PR sync

The periodic coordinator sweep lives inside `runPrSync`
(`src/extension.ts:~4768`), after two awaited `gh`/`git` network phases, on a
60 s timer (`PR_SYNC_INTERVAL_MS`). `syncPrStatuses` is awaited inside the
outer `try` with no guard of its own, so any throw from it — offline, no auth,
rate limit — skips the graph sweep for that tick entirely. A run whose wake-up
hit a dead port then has no second path back, which is precisely the failure
the sweep exists to cover ("a completion that committed to the database is
always eventually scheduled"). The graph's liveness must not depend on GitHub
being reachable.

## G5 — the planner prompt's `$entry` wording invites the reserved-identifier rejection

`skills/graph-planner/SKILL.md` line ~155 describes `$entry` as a legal value
where a node is named, in the section covering edges. `entries[]` is a list of
node ids where `$entry` is rejected as a reserved sentinel (`parse.ts:247`).
Run 5 died on `entries[0]: "$entry"`. The prompt must state, per field, where
the sentinel is legal and where it is not.

## G6 — a stuck graph is invisible in a diagnostic report

The report generated for this ticket contains `cores`, `gateRuns`,
`phaseMarks`, `stages`, `topology` — and nothing about graph runs, planner
runs, node runs or blocked reasons, while four graph runs sat blocked. The
whole subsystem that owns the ticket's `impl` stage is absent from the one
artifact a user sends when it is stuck. Reporting observes and never reaches
back (`docs/arch/diagnostics.md`), so this is a read-only addition.

## G7 — recovery from a dead process is manual

Runs 1 and 3 both parked on a process that vanished (`launch-unknown`,
`dead at reconcile`) and both require a human click — discard the unknown
process, or Resume the reserved visit. Both are correct as safety defaults;
neither is surfaced anywhere except the dashboard of the right project, so an
unattended graph simply stops.

## Already fixed on this branch

Run 4's `draining` stall is the defect commit `2f7f741` addresses:
`reconcilePlanningPlanner` judged only `kind='bootstrap'` planners in
`planning`, so a replan planner working at `draining` had no crash-matrix
branch, and `draining` is the one status nothing else leaves.

## Fix order

1. **G1** — scope the sweep and the reconcile listing to the window's project,
   filter to non-terminal statuses, and refuse to compile when the manifest is
   unresolved. Cheapest fix, kills the largest class of bogus blocks.
2. **G2 + G3** — wire `compileWithRepair` into the bootstrap accept path, and
   feed the newest diagnostics into the replan prompt.
3. **G4** — give the graph sweep its own tick, independent of `gh`.
4. **G5** — per-field sentinel rules in the planner prompt.
5. **G6** — a graph section in the diagnostic report.
