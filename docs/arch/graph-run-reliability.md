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

## G8 — repository identifiers had two halves that disagreed (fixed)

A claim's `repo` was parsed against a lowercase-only safe-identifier grammar,
while the compile context keyed its repository map by the VERBATIM manifest
name. For a manifest declaring `BE:` / `DBGW:` no value satisfied both: the
uppercase spelling failed the grammar, the lowercase spelling missed the map.
Every agent node in such a project was rejected at parse or blocked at compile.

Both halves now canonicalize through `canonicalRepoId` (`src/runtime/repoId.ts`):
the parser accepts a repository claim in the manifest's own casing and returns
it case-folded, and `graphCompileContext` / `repoWorktreeIndex` key by the same
form. Two manifest keys that canonicalize alike are ambiguous, so they are
rejected at MANIFEST validation (`assertDistinctRepoIds`), where the author can
rename the key — never three layers away at graph compile.

Two consequences of the same investigation are fixed with it:

- An agent node whose claims resolve to no worktree used to hit
  `parkLaunchFailure` with a generic reason (and `ready → blocked`, an illegal
  edge, threw). It now parks through `launching` with a reason naming the
  claimed repositories.
- The planner prompt carries a **Legal values for this run** block
  (`plannerVocabulary`) listing the exact repository, profile, and command ids
  the run compiles against — a run with no commands says so, instead of leaving
  the planner to infer a set it cannot see.

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

---

# Second audit, 2026-09-06 — the remaining stuck-gaps

G1/G3/G4/G5/G8 are fixed on this branch (project-scoped `activeGraphRunIds`
and `reconcilableGraphRunIds`, `manifestResolvedFor` guards on BOTH accept
paths, the graph sweep's own tick, `rejectPlan`'s compile-repair budget with
reconcile's re-prompt fallback). What follows is what a fresh read of the run
loop still finds. Every item is the same shape: **a run status whose only
declared exit is produced by an event that will never happen.**

## H1 — a rejected REPLAN document stranded the run in `draining`, forever (fixed)

`acceptSubmittedReplan` (`driver.ts:766`) has no counterpart to the bootstrap
path's `rejectPlan`. Three of its four failure exits return
`{kind:'rejected'}` and change NOTHING:

- unreadable snapshot (`driver.ts:796`),
- unparseable document (`driver.ts:798`),
- `submitReplanDocument` → `invalid-document` (`replan.ts:534`) — which returns
  from inside its transaction before any write.

The replan planner run stays `submitted`; the graph run stays `draining`. The
next reconcile tick reads the SAME snapshot, re-parses it, re-rejects it. No
attempt counter, no diagnostics file, no reason on the row, no block.
`extension.ts:4398` only acts on `kind === 'accepted'`, so the rejection is not
even logged. `reconcilePlannerRun`'s repair branch is bootstrap-only by
construction (`reconcile.ts:490`), and `submitted` is not a live-session-loss,
so reconcile is a no-op too. `draining → blocked` is not a declared edge.

The run is unreachable by Resume (`recoverGraphRun` requires `blocked`),
invisible to the coordinator sweep (`activeGraphRunIds` selects `running`
only), and shows as "Draining" with no action in the Inside panel. This is
run 4 of the first audit's table reappearing through a different door.

**The bootstrap path's repair contract must be the replan path's too.**

**Fixed.** `acceptSubmittedReplan`'s three rejection exits now route through
`rejectReplan` → the same `rejectPlan` the bootstrap path uses, parameterised
by the run status the repair holds (`planning` for a bootstrap plan,
`draining` for a replan). So a rejected replan re-prompts the SAME replan
planner run with the diagnostics (`submitted → blocked`, attempt recorded,
`diagnostics/planner-<id>.json` written), the run stays `draining` between
attempts, and `reconcilePlannerRun`'s blocked-planner branch — bootstrap-only
before — recovers a re-prompt that never fired for either kind. An exhausted
repair parks the run at `blocked` through the new `draining → blocked` edge,
where the typed Resume reaches it. `extension.ts`'s draining branch now acts
on all three outcomes instead of `accepted` alone.

## H2 — Stop drained a run that nothing would ever undrain (fixed)

`stopActiveGraph` (`entryPoints.ts:242`) CASes `running → draining`
deliberately — "a stop is a deliberate halt, not a fault the Resume would
retry" (`extension.ts:5010`). But it elects no replan and creates no replan
planner run, and the ONLY declared productive exit from `draining` is an
accepted replan submission. Reconcile 2.6 dispatches a draining run to
`reconcilePlannerRun(…, 'replan')`, which returns a no-op the moment no replan
planner row exists (`reconcile.ts:475`).

So every Stop permanently strands its ticket's graph. Note the revision is
still `active` (Stop never touches it), so `draining → running` is both legal
and correct here — nothing needs to be recompiled. What is missing is the
actor: no sweep, no reconcile branch, and no Inside action produces it.

**Fixed.** `restartStoppedGraph` (`entryPoints.ts`) is that actor, reached by a
new `graph-restart` Inside control minted only on a `draining` run with no
replan planner still owing it a submission. It CASes `draining → running` on
the still-active revision and the host tick claims its entry tokens
immediately. A run draining FOR a replan is refused at BOTH layers (the
dispatch guard and the coordinator function) — that run is mid-replan and the
coordinator owns its exit. Nothing here is automatic: a Stop is a deliberate
halt, so its exit is a deliberate click.

## H3 — a non-`closed` run permanently blocks its ticket from starting another

`extension.ts:5857` refuses a new graph launch when ANY graph run row exists
for the ticket, in ANY status, and hands the user to the Inside panel — which
offers a typed Resume for `blocked` only. A run left `cancelled`, `stale`, or
`draining` (H1, H2) therefore locks the ticket out of the graph approach
entirely: Start says "the coordinator owns continuation", and the coordinator
owns nothing. The guard's intent is "never two live runs"; its predicate is
"never a second run".

## H4 — a deferral ages but never times out

`recordDeferral`/`agingPriority` (`sweep.ts:314`) raise a waiting node's
priority the longer it waits, which is the right anti-starvation policy
between *competing* nodes. There is no ceiling: a deferral whose refusal can
never clear (a `resource-conflict` against a lease held by a node that is
itself parked, a `parallel-slot-busy` against a slot nothing releases) simply
defers on every tick forever. The run stays `running` and looks healthy — no
block, no diagnostic after the first `fresh` one, nothing in the panel that
says "this node has waited 40 minutes". A bounded max-deferral-age that parks
the run `blocked` with the refusal reason would make it recoverable, which is
the discipline every other failure here already follows.

## Still open

H3 (the launch guard's any-status predicate) and H4 (deferrals with no
ceiling) are unfixed.

## The invariant these four share

A graph run's non-terminal statuses must each have at least one exit that some
actor — a sweep, a reconcile branch, or a user action the panel actually
offers — can always produce. `draining` has one exit and one producer, and
three separate paths reach `draining` without that producer.
