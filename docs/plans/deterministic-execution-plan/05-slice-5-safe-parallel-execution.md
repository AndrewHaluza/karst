# Slice 5 — Safe Parallel Execution

**Entry gate:** Slice 4 exit gate holds.
**Ships:** isolated node execution workspaces, durable physical-domain leases, fork lineage and join correlation under real concurrency, deterministic integration, fairness, concurrent fault projection, multi-window race coverage — and only here may `maxParallel > 1` be enabled.

Until this slice's final task, the packaged default stays `maxParallel: 1`. Every mechanism below is written and tested at 1 first, then exercised at >1; a mechanism that only works at 1 is not done.

## Task 1 — Node execution workspaces

**Files:** `src/approaches/graph/workspace/provider.ts`, `cleanup.ts` (+ tests).

**Changes:**
1. A workspace must have an **independent working tree, index, HEAD/refs namespace, and writable Git metadata**. An ordinary linked Git worktree sharing mutable common metadata is **insufficient** for concurrent writers unless the provider additionally sandboxes Git operations. A local clone may share immutable object storage but never writable refs/index state.
2. Workspaces are created from the canonical ticket integration heads observed **when the activation is claimed**; those per-repository base commits/digests are stored on the node run, and sibling fan-out activations released by the same predecessor share the same base. Because predecessor completion includes integration, later dependent and loop nodes start from the already-integrated state.
3. Cross-device: a local clone sharing immutable object storage is acceptable **only when both paths are on one filesystem**; otherwise a full clone is used.
4. A pre-existing workspace directory from a prior crashed run is removed before creation — its owning node run is by definition superseded — and the removal goes through the same reap that checks **process attribution first** (`runtime/serverIdentity.ts`; a recorded pid is a recollection, never a handle).
5. Location is `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/workspaces/<nodeRunId>/<repoName>/` — outside every worktree, so `ship`'s `git add -A` cannot see it and no exclude rule is needed.
6. Every workspace process registers with the `servers` registry keyed by its `cwd`, so `removeWorktree` → `stopServersUnder` and the global `reapStaleServers` sweep both reach it.
7. `maxAggregateWorkspaceBytes` (packaged 20 GiB, hard ceiling 100 GiB) is measured per graph run; exceeding it blocks with `graph-budget-exhausted` rather than starting another workspace.

**Tests (RED first):** two concurrent writers in separate workspaces do not share index/refs; a cross-device target falls back to a full clone; a crashed run's directory is removed only after attribution says the process is not live; a workspace over the byte ceiling blocks; `git status` in the canonical worktrees stays clean throughout.

## Task 2 — Durable physical-domain leases

**Files:** `src/store/graph/leases.ts`, `src/approaches/graph/coordinator/leases.ts` (+ tests).

**Changes:** integration and conflicting execution serialize on a **durable database-backed lease** — an `approach_resource_leases` row with status `held`, acquired **in the claim transaction** — never an in-memory mutex, because two windows may legitimately complete different nodes concurrently. `UNIQUE(owner_node_run_id, physical_domain)` is what makes the affected-row check enforcement rather than convention.

Physical domains are keyed by **canonical worktree realpath plus Git common-directory identity**, never manifest repository name: several repository entries may intentionally share one `repoPath`, so the name cannot answer which tree a lease covers.

Lease transitions: `held → released` (termination proven **and** the change set integrated, preserved behind a blocker, or explicitly discarded), `held → ambiguous-process` (termination unprovable), `ambiguous-process → released` (only via "Discard unknown process"). **No lease is released while process termination is unknown.**

**Tests (RED first):** two windows acquiring the same domain → one winner; a lease survives a host restart; an `ambiguous-process` lease blocks a conflicting launch and is releasable only by the discard action; the unique index rejects a duplicate insert.

## Task 3 — Conflict rules and the scheduler

**Files:** `src/approaches/graph/coordinator/conflicts.ts` + test. Deterministic rules, implemented as a pure function over claims plus the injected physical-domain map:

- read/read on the same path may run together;
- write/write overlap conflicts; write/read overlap conflicts;
- directory claims overlap descendants; repository-wide claims overlap every path in that repository;
- trusted commands inherit access and repository breadth from the **pinned allowlist definition**, never planner prose;
- joins and pure gates claim no repository resources;
- a node waiting on dependencies is **not ready** and acquires no resources — and must never be reported as resource-blocked.

Read-only nodes may share a snapshot only when the executor enforces read-only access. Repository-wide commands run against the canonical integrated ticket worktree and wait for all conflicting integrations and readers; commands with `write` access take the physical repository exclusively.

Ready ordering is deterministic by activation creation time and token id, with **bounded aging** so a wide-resource node cannot starve behind repeatedly generated narrow loop work. Multi-window ordering is **consistent but not globally reproducible**: two tokens created in different windows within one millisecond order by token id, which reflects commit sequence rather than logical cause — this is stated, not hidden.

Every deferral persists its **reason**, and Inside shows it, so deliberate serialization never looks like a scheduler defect.

**Tests (RED first):** each conflict rule; path-disjoint agents run concurrently; repository aliases sharing `repoPath` conflict correctly; a dependency-waiting node is never labeled resource-blocked; aging prevents starvation; the shared external-process ceiling counts agent sessions **and** per-repository command subprocesses.

## Task 4 — Fork lineage and join correlation under concurrency

**Files:** `src/approaches/graph/coordinator/lineage.ts` + test.

**Changes:** `fork_instance_id` is a host-generated UUIDv7 minted at each fork execution. Every descendant token carries a bounded fork-lineage **stack**, outermost first, to the compiler's nesting bound. Join correlation matches on the **full lineage stack and the fork's visit number**, so two arrivals from the same predecessor at different loop iterations never correlate. Artifact instances record the producing run's lineage stack; input resolution walks the activation's own lineage.

A join firing stays one all-or-nothing transaction (Slice 3 Task 4) and must now be proven under genuine parallel arrivals from two windows.

**Tests (RED first):** two loop iterations of one fork produce two independent join firings; a partial arrival set never fires; arrivals split across two windows' completion transactions fire exactly once; lineage depth beyond the bound is rejected at compile.

## Task 5 — Deterministic integration under parallelism

**Files:** `src/approaches/graph/integration/*` (+ tests).

**Changes:** disjoint writers integrate **serially** under physical-repository locks in deterministic node-run order after actual-diff validation. An out-of-claim diff blocks with `resource-claim-violated` **before** integration. An integration conflict preserves the isolated workspace and the canonical worktree and routes to replan/expert diagnosis or explicit user resolution — never `complete`. V1 never silently widens a running node's claim.

**Tests (RED first):** two disjoint writers integrate cleanly in node-run order; an overlapping pair serializes; a conflict preserves both trees and blocks; interleaved integration and a repository-wide command serialize by physical domain.

## Task 6 — Concurrent fault projection

**Files:** `src/model/inside/graph.ts`, `src/workflow/graphMarkerGuard.ts` (+ tests).

**Changes:** when multiple node runs block simultaneously, the stage block projects the **earliest by durable event order** while Inside lists every blocking planner/node run. The first graph fault stops new launches and drains already-active work so additional evidence is recorded without multiplying damage.

**Tests (RED first):** three simultaneous faults produce one stage block naming the earliest and an Inside list of all three; the first fault stops new launches.

## Task 7 — Raise the packaged concurrency default

**Changes:** packaged `maxParallel` 1 → 4. Hard ceiling stays 8. This change belongs to **this** slice and no earlier one: parallelism without workspaces, leases, and lineage is the corruption class the whole slice exists to prevent.

**Tests:** the packaged-default equality test from Slice 1 Task 1 is updated in the same commit; a project configuring 9 is still refused at manifest validation.

## Slice verification

```bash
npm run typecheck
npm test
npx vitest run src/approaches/graph src/store/graph
```

Expected: every mechanism passes at `maxParallel: 1` **and** at 4; multi-window races produce one winner everywhere a winner is required; no test relies on wall-clock sleeps for ordering. `99-INVARIANT-CHECKLIST.md` sections **B**, **D**, **E**, and **J (parallel safety)** pass.
