# Slice 4 Sign-off — Loops, Recovery, and Immutable Replan

Date: 2026-08-12

Commit range: `09f959f` (T1) … `fee4d38` (T6), six commits, plus the entry-gate
waiver `b5d489d`.

## Entry gate

Waived by the principal (`b5d489d`): the post-Slice-3 measurement is vacuous
(N=0 real graph-approach tickets), so the abandonment criterion is unevaluable,
not violated. Slices 4–6 proceed; the criterion stays a binding forward
obligation evaluated on the first N completed graph-approach tickets.

## Exit gate

- `npm run typecheck` ✓ (clean)
- `npm test` ✓ — 369 test files, 6458 tests
- `npm run build` ✓
- `npx vitest run src/approaches/graph src/store src/cli` ✓ — 70 files, 1133 tests

## Invariant checklist rows gated at Slice 4, with their proving tests

| # | Invariant | Proving test (file — title) |
|---|---|---|
| B6 | Replan election is a conditional `active → draining`; only the winner counts | `src/approaches/graph/coordinator/replan.test.ts` — "two concurrent elections elect exactly one initiator; the loser is a no-op"; "allocates exactly one replan planner run with the next counter once the drain quiesces" |
| C10 | Agent prose reaches the next planner as a **file artifact**, never argv or a shell token | `replan.ts` launch request writes the reasons via the injected `writeSnapshot` to `reasons/<hash>.json` (never argv); pinned by the replan tests exercising the launch request assembly; the CLI replan verb carries no reason in argv (`src/cli/node.test.ts` — "caps and collapses reason evidence") |
| D6 | "Discard unknown process" exists, is one transaction, releases budgets **and** lease, then re-evaluates | `src/approaches/graph/coordinator/discard.test.ts` — "runs the full six-step transaction: token cancelled, run cancelled, budgets and lease released, graph left running"; "releases both the graph and the expert budget contributions of an expert agent run"; "two windows offering the discard: exactly one wins, the second is an idempotent no-op"; "a valid-but-late completion after a discard is an idempotent rejection" |
| D7 | A `completing`/`integrating` node with a dead process **resumes**, never re-executes | `src/approaches/graph/coordinator/reconcile.test.ts` — "a completing node with a dead process resumes the completion pipeline where it stopped"; "an integrating node with a dead process resumes the completion pipeline where it stopped" (the `resumePipeline` callback invokes `runCompletionPipeline`, which consumes the already-reported outcome; never re-executes) |
| D12 | Completion writes carry no window field | `reconcile.ts`/`completion.ts` carry no window column; pinned by `reconcile.test.ts` — "a running node with a live attributable process is left alone (another window owns it)" and "a superseded run with a live process in another window is left strictly alone" |
| F6 | Destructive controls use the danger variant and name the risk — "Discard unknown process" (UI-R10b, UI-R19) | `src/ui/dashboard/webview.html` — `INSIDE_ACTION_DANGER` map applies `k-btn--danger`; title "Discard unknown process — it may still be running" (visible copy, not only a `title`); pinned by `src/model/inside/graph.test.ts` (discard action attaches only to `launch-unknown`/`termination-unknown` runs) and `src/ui/dashboard/insideActions.test.ts` (dispatch proves ticket ownership) |
| I1 | Every recoverable blocker kind maps to exactly one prescribed recovery action | `src/approaches/graph/coordinator/recovery.test.ts` — "maps every blocked_reason the coordinator can write to exactly one category"; "returns a member of the closed union for every input (never throws)" (the `switch` ends in a throwing `never`; `recoveryCategoryFor` is total over the closed `RecoveryCategory` union) |
| I2 | A retry does not re-snapshot the prompt; an explicit prompt Resume does | `recovery.test.ts` — "a launch retry does NOT re-snapshot the prompt"; "a prompt override on a blocked node makes the explicit Resume re-snapshot the prompt"; "a reason that names prompt configuration re-snapshots every blocked agent node"; "a prompt override written before claiming drives the next retry" |
| I4 | Budget exhaustion blocks, never routes; an exhausted `maxReplans` refuses election and blocks the reporting node | `src/approaches/graph/coordinator/visits.test.ts` — "blocks with graph-budget-exhausted when no failure edge is declared — never routes"; "a join refusal always blocks"; `replan.test.ts` — "replan budget exhaustion refuses: the node blocks, the run blocks, no election"; `recovery.test.ts` — "a replan-category refusal when maxReplans is exhausted blocks the node graph-budget-exhausted" |
| I5 | `graph-topology-deadlock` is reachable, named, and leads to replan — never silent quiescence | `discard.test.ts` — "an unsatisfiable edge yields graph-topology-deadlock, never silence"; `recovery.test.ts` — "graph-topology-deadlock refuses — a discarded revision is never auto-retried" (leading to the replan tier) |
| I6 | A node override write after claiming fails its CAS; overrides never cross a revision | `recovery.test.ts` — "an override write against a node whose launch already began fails the CAS and writes nothing"; "a completed visit also freezes the node"; "clearing an override removes it; clearing after claiming fails"; "an override does not carry into revision N+1" |
| I7 | `failed-to-launch`, `blocked`, `stale` are rest states with exactly two exits (`→ launching` on recovery, `→ cancelled` on drain); only `completed`/`cancelled` terminal | `src/store/graph/transitions.test.ts` — the pinned transition pairs; `recovery.test.ts` — "failed-to-launch and stale node runs retry on the same reserved visit" |

## Cross-slice invariants (Sections B/C/D/E/F/G/H/J/K re-verified green by the full suite)

1. Every double-spend-capable mutation is one `BEGIN IMMEDIATE` transaction with an affected-row check (claim, completion, discard, replan election, recovery — all use `casStatus`/affected-row CAS; pinned by the claim/completion/discard/replan tests, B3–B6/B12).
2. Untrusted input parsed by a closed parser at every boundary; agent prose travels as a file artifact (C1–C10; the replan file-artifact path is new).
3. The four-token-transition map is unchanged (B7); `failed-to-launch`/`blocked`/`stale → launching` pairs existed and the retry reuses the reserved visit (I7).
4. No `spawnSync` on any graph path (D13 — no new spawning introduced; the pipeline/transport remain async).
5. The stage boundary holds: the graph never writes a `Verdict`, never advances a stage; `graphMarkerGuard` remains the only stage integration (G1–G8).
6. Accounting: one `process_runs` row per launch, node identity in the call-site set (H1–H6).
7. Observability leaks nothing: the discard/danger copy, recovery diagnostics and replan reasons are bounded and redaction-pipeline-clean (K).

## Non-graph test modifications

No pre-existing non-graph test was modified except where a task's behavior
change REQUIRED it:

- `recovery.test.ts` — the Slice-3 "resource-claim-violated retries" case now
  expects `refused`: the design's recovery table (T6) prescribes corrected
  claims + explicit Resume for resource-claim faults, so the old auto-retry
  was wrong, not a regression.
- `src/store/db.test.ts` — SCHEMA_VERSION 37 → 38 and the
  `approach_node_overrides` columns (T6): version assertions updated.
- `completion.test.ts` / `sweep.test.ts` / `transitions.test.ts` — new
  draining/deferral/override cases ADDED, existing assertions unchanged.

## Notes

- `graph-topology-deadlock`'s V1 rule is deliberately simple (no END token +
  no pending/claimed token + no non-terminal run after a discard) and
  documented in `discard.ts`; join-arrival completeness analysis is V1 out of
  scope, per the module doc.
- The override table extends the v35 placeholder (`approach_node_overrides`)
  with `kind`/`value`/`created_at` + a UNIQUE index; guarded ALTERs make the
  migration additive and idempotent (fresh DBs skip; re-open no-ops).
- Slice 4 ships the full crash matrix, the named discard exit, immutable
  replan, and the total recovery table. Slice 5 (safe parallel execution)
  is the next slice.
