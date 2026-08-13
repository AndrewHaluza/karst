# Slice 4 — Loops, Recovery, and Immutable Replan

**Entry gate:** Slice 3 exit gate holds **and** the post-Slice-3 measurement satisfies the abandonment criterion.

> **Entry-gate waiver (2026-08-12, principal decision):** the post-Slice-3
> measurement (`measurement/post-slice-3.md`) is vacuous — zero real
> graph-approach tickets exist (N=0), so the abandonment criterion is
> unevaluable, not violated. Per the principal's explicit direction, the gate
> is waived: Slices 4–6 proceed now, treating unevaluable as not-violated.
> The criterion remains a binding forward obligation evaluated on the first N
> completed graph-approach tickets (Slice 6's entry gate), and a violation
> there reverts the flip and stops the remaining work.

**Ships:** repeated visits with distinct identities, causal artifact binding, budget enforcement, the full crash/reload matrix, stale and unknown process handling with a named escape, replan election and drain, and revision N+1.

## Task 1 — Repeated visits and loop budgets

**Files:** `src/approaches/graph/coordinator/visits.ts`, `src/store/graph/nodeRuns.ts` (+ tests).

**Changes:** each visit of a node in a revision gets a monotonic visit number and a distinct node-run identity, so a fix→verify→fix cycle never overwrites prior evidence. Every logical visit — **including zero-token gate and join visits** — counts toward `maxNodeRuns` and the node's `maxVisits`. A loop without a finite node-visit budget was already rejected at compile; runtime additionally refuses to allocate a visit beyond the budget. Exceeding a budget produces a bounded deterministic outcome when the topology declares a gate/edge for it; otherwise the graph blocks with `graph-budget-exhausted`, never routes.

**Tests (RED first):** three visits of one node produce three node runs with distinct ids and evidence; the fourth is refused at `maxVisits: 3`; a gate visit consumes budget; budget exhaustion blocks rather than routing when no edge declares it.

## Task 2 — Causal artifact binding

**Files:** `src/approaches/graph/artifacts/resolve.ts` + test.

**Changes:** every production creates an immutable `ArtifactInstance` keyed by graph revision, producer planner/node run, visit, and fork lineage, storing logical id, content-addressed snapshot path, SHA-256, byte size, media type, producer identity, and creation time. Inputs resolve to the **newest successful instance in the activation's causal lineage**; planner artifacts are roots. `artifact-exists` gates inspect **causal** instances, not any historical file with the same logical id. An ambiguous or missing binding **blocks**; it never selects a global "latest". An instance from a superseded revision is never in a new revision's lineage, which is what prevents cross-revision binding.

Karst validates required output artifacts before accepting an effective `complete`. The agent-authored `complete` stays immutable reported evidence, but missing or unsafe output leaves the effective outcome **null** and moves the node to `output-artifact-missing` or `artifact-unsafe`; **no edge is emitted**.

**Tests (RED first):** two loop visits produce two instances and the consumer binds the causal one; a same-id instance outside the lineage is not selected; an ambiguous binding blocks; a missing required output leaves the effective outcome null and emits no edge.

## Task 3 — Reload and crash matrix

**Files:** `src/approaches/graph/coordinator/reconcile.ts` + tests. Every row below is a test:

| Found state | Required behavior |
|---|---|
| `running`, live generation/process owned by another window | left alone |
| no pid/generation evidence | never declared dead merely because this window cannot see its terminal |
| crash before spawn (owner nonce, no identity) | provably retryable |
| crash after possible spawn, before identity | `launch-unknown`, blocks |
| `running`, demonstrably dead process | marked `stale`; graph blocks for recoverable retry |
| `running`, process-tree death unprovable | `termination-unknown`; leases retained |
| `completing`/`integrating`, dead process | **resume the completion pipeline where it stopped** — terminate-verify, snapshot, integrate, consume the already-reported outcome. Do **not** re-execute: the outcome is in hand and re-running duplicates spend and integration |
| `completing`/`integrating`, live attributable process | revert status to `running`; completion proceeds |
| completed node whose successor tokens committed | scheduled exactly once |
| pending non-conflicting tokens | resume scheduling |
| draining revision | waits for active work, then continues replanning |
| blocked graph | stays blocked until Resume/config change |
| completed graph at `impl` | stays awaiting the explicit marker |
| ticket no longer at `impl` | cancel unscheduled tokens, prevent new graph work, rewrite no completed evidence |

**Window semantics:** completion writes are **window-agnostic by design** — there is no window field in the conditional UPDATE and there must not be, because after a reload the old window's agent is still the legitimate owner. "Wrong-window" applies solely to loopback routing identity. Multiple windows may reconcile concurrently; correctness comes from durable conditional claims.

`reconcileStageRuns`-style staleness applies to graph runs: any non-terminal run is marked `stale` when a successor run for the same ticket/stage attempt exists (the earlier host died) — a row with no pid, or one alive in another window, is left strictly alone.

## Task 4 — "Discard unknown process"

**Files:** `src/approaches/graph/coordinator/discard.ts`, Inside control (+ tests).

**Why:** `launch-unknown` and `termination-unknown` are otherwise a permanent stall (REVIEW-1 C1/H4/H5). This is the named exit.

**Changes:** one explicit user action, one transaction, these steps in order: (1) verify the node is in one of the two ambiguous statuses; (2) conditionally move its token `claimed → cancelled`; (3) mark the node run `cancelled`; (4) release its reserved graph, node-visit, and expert budget contributions, so a discarded revision does not permanently consume revision N+1's ceilings; (5) release its lease; (6) re-evaluate the graph, blocking with `graph-topology-deadlock` if the edge is now unsatisfiable — a recoverable blocker leading to replan, so the user is never left with a silently dead graph.

This is the **only** path that releases a lease without proven termination. It is never automatic, and its UI copy names the risk because a process may still be running (UI-R10b danger variant, UI-R19: the explanation is visible, never only a `title`). The transaction is conditional on current status, so when two windows both offer it exactly one succeeds and the other is an idempotent no-op. A valid-but-late completion arriving after a discard is rejected idempotently.

**Tests (RED first):** the full six-step transaction; budgets are released; two windows → one winner; a late completion after discard is an idempotent rejection; an unsatisfiable edge yields `graph-topology-deadlock`, not silence.

## Task 5 — Replan election and drain

**Files:** `src/approaches/graph/coordinator/replan.ts` + tests. The ten steps of the design's Immutable Replanning section, implemented verbatim:

1. elect exactly one initiator with a conditional `active → draining` transaction; only the winner increments the accepted replan count;
2. stop launching new nodes from that revision;
3. persist later replan requests as bounded evidence without launching another planner;
4. let running nodes finish, terminate/snapshot them, record artifacts and evidence, but **suppress all successor creation** once the revision is draining;
5. cancel pending activations and finish/cancel claimed activations once active work quiesces;
6. allocate exactly one new `PlannerRun` transactionally with quiescence and the next planner-run counter;
7. launch the planner with original ticket context, prior plan/graph snapshots, completed artifacts, failures, diffs, resource conflicts, and the elected plus secondary replan reasons — the reasons travel as a **file artifact, never as argv or a shell token**, and the planner prompt frames them as untrusted agent-reported text;
8. validate a complete new graph document;
9. persist revision N+1 with `supersedes_revision_id` and bounded rationale;
10. create new root fork/entry tokens and resume scheduling.

A planner submission for a revision that is no longer `active` — a concurrent replan won election while this planner ran — is an **idempotent no-op**: the late run is marked `stale`, its snapshot discarded unpersisted, no revision created.

Revision N+1's compilation validates its resource claims against still-`held` leases from draining revision N; a conflicting node is **scheduled later**, which is a deferral, never a compile error. A drain whose leases never release because the holder is `termination-unknown` is resolved only by Task 4's action — the deadlock has a named exit.

**Budget refusal:** when a node reports `replan` and `maxReplans` is already exhausted, the election is **refused rather than attempted**: the reporting node's effective outcome becomes `blocked` with reason `graph-budget-exhausted`, the graph transitions to `blocked`, and the node's isolation and leases are retained for inspection. Never routed as an unbounded replan, never silently dropped.

**Tests (RED first):** concurrent replan requests elect one initiator and one planner run; draining completions record evidence and create no successors; a late planner submission is a no-op and revision N+1 is unaffected; N+1 supersedes without rewriting history; replan budget exhaustion blocks; a conflicting claim defers instead of failing compile.

## Task 6 — Category-specific recovery

**Files:** `src/approaches/graph/coordinator/recovery.ts` + tests. The design's recovery table implemented as a total function over the closed category set. Every "retry the same reserved visit" action is the node-run transition `failed-to-launch` / `blocked` / `stale` → `launching`: the token stays `claimed`, no second visit is allocated, and only the launch-attempt counter moves. These details are load-bearing:

- provider/model/effort configuration → retry the **same reserved visit** with the latest late-bound configuration and a new launch attempt; a launch retry does **not** re-snapshot the prompt;
- prompt configuration → explicit Resume **re-snapshots** the effective prompt bytes from current packaged/override files and retries the same reserved visit;
- planner graph invalid / planner artifacts missing → a new planner run, subject to planner/replan budget;
- command definition changed → compile a new revision before execution;
- launch failure with proven no process → retry the same reserved visit;
- `launch-unknown` / `termination-unknown` → require positive resolution or explicit user cleanup; **never automatic retry**;
- output/artifact/resource-claim fault → replan or explicit retry after corrected artifacts/claims;
- integration conflict → preserve workspaces and canonical worktrees, then replan/expert diagnosis or explicit user resolution;
- budget exhaustion → configuration change within hard caps plus explicit Resume.

The red fault deep-links to the exact node/profile/prompt/command editor. Node overrides are editable for `ready`, `blocked`, and `failed-to-launch` nodes; override writes use a status/version compare-and-set and **fail once launch claiming begins**. An override is scoped to `(graph revision, node id)`, applies to every future unclaimed visit or retry in that revision until cleared, never mutates an active or frozen launch, and does **not** carry into a replanned revision whose node identity may mean something different. V1 has no one-visit-only override.

**Tests (RED first):** each category takes its prescribed action and no other; a retry does not re-snapshot the prompt while an explicit prompt Resume does; an override write after claiming fails the CAS; an override does not carry into revision N+1.

## Slice verification

```bash
npm run typecheck
npm test
npx vitest run src/approaches/graph
```

Expected: the full crash matrix green; the token transition map still admits exactly four transitions; budgets released on discard; replan single-winner under concurrency; every recovery category exercised. `99-INVARIANT-CHECKLIST.md` sections **B**, **D**, and **I (recovery has an exit)** pass.
