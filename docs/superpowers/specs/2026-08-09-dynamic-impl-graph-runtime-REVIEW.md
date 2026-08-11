# Dynamic IMPL Graph Runtime Design — Parallel Review Report

**Design reviewed:** [2026-08-09-dynamic-impl-graph-runtime-design.md](./2026-08-09-dynamic-impl-graph-runtime-design.md)
**Review timestamp:** 2026-08-09T18:42:00Z
**Reviewer model:** opencode-go/mimo-v2.5 (6 parallel review agents)
**Review focus:** Security/Trust, Scheduler/Concurrency, Persistence/Schema, Recovery/Reload, Architecture/Modules, Product/UX

---

## Summary

6 parallel reviewers produced **47 findings** across the 1124-line design spec. Deduplication and cross-referencing reduced the set to **42 unique findings**.

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 14 |
| Medium | 16 |
| Low | 8 |
| Informational | 1 |

---

## Critical

### C1. Token `claimed` → never `consumed` creates permanent scheduler stall
**Section:** Persistence — `approach_graph_tokens`
**Issue:** A `claimed` token that is never `consumed` due to process death (`termination-unknown`) stays `claimed` forever. Successor tokens can never become `pending`, and downstream nodes starve. Resume explicitly does not clear graph-level blocks without a typed graph recovery action, so there is no automatic escape.
**Recommendation:** Define a `claimed` → `cancelled` or `claimed` → `stale` transition for tokens when a process death is confirmed or the user explicitly clears a `termination-unknown` node. Resume on a `termination-unknown` node should atomically cancel its claimed token, release leases, and re-evaluate the graph.

### C2. ApproachDef type silently drops all graph configuration
**Section:** Configuration Model (`approaches:` YAML)
**Issue:** `ApproachDef` (`manifest/types.ts`) has exactly six fields: `id`, `label`, `description`, `entrypoint`, `source`, `recommended`, `workflow`, `enabled`. None of `planner`, `profiles`, `commands`, or `graph` are modeled. `validateApproaches` silently drops unknown keys. A project writing the design's YAML will have every graph configuration silently discarded.
**Recommendation:** Extend `ApproachDef` with optional `planner`, `profiles`, `commands`, and `graph` sub-objects, update `validateApproaches`, and add them to `SECTION_FIELDS.approaches` in `sections.ts`.

### C3. Planner prompt artifact path writable by agent nodes
**Section:** Artifacts and Context Policy / Immutable Replanning
**Issue:** The packaged planner prompt lives at `.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md` inside the repository working tree. A malicious implementation agent with write access to that path could modify the planner prompt, injecting instructions that persist into future replans.
**Recommendation:** Snapshot the planner prompt at graph-run creation (like every other artifact) and read only from the immutable snapshot. The mutable file on disk becomes a source for the next run's snapshot, not the current one. Alternatively, exclude the approach package directory from agent write claims.

---

## High

### H1. TOCTOU race between artifact validation and snapshot
**Section:** Artifacts and Context Policy
**Issue:** Validation (walking paths, rejecting symlinks) and byte-copy are two separate operations. A malicious agent process could replace a validated file with a symlink between the link-rejection walk and the content-addressed copy.
**Recommendation:** Validation and byte-copy must be a single atomic operation per file: open FD → fstat → verify type/size/link-status → read from same FD into storage. Never re-resolve the path between validation and read.

### H2. END quiescence detection not atomic
**Section:** Scheduler Runtime
**Issue:** Quiescence check and graph completion marking are described as separate steps. A join can become satisfied in a completion transaction that also creates the join's successor token. If the quiescence check reads state after predecessor completions but before the join's successor token is processed, the graph could be marked completed while a pending non-END token still exists.
**Recommendation:** Quiescence detection and graph completion marking must occur in a single `BEGIN IMMEDIATE` transaction that re-reads all pending/claimed/join state atomically.

### H3. Draining revision → new revision token race
**Section:** Immutable Replanning
**Issue:** Revision N's already-running nodes complete and emit successor tokens while revision N+1's new root/entry tokens are being created. The transition from `draining` to `running` for revision N+1 is not explicitly defined. If the IMPL marker guard fires during this window, it could advance the stage prematurely.
**Recommendation:** Revision N+1's tokens and status become `running` only after revision N's quiescence is confirmed (no active node runs, no held leases for the draining revision). This transition must be a single conditional transaction. The IMPL marker guard must reject if any revision is in `draining` status.

### H4. `launch-unknown` becomes permanent when positive resolution is impossible
**Section:** Reload/Multi-Window Recovery
**Issue:** If the spawned process is immediately reaped by the OS (Jetsam, OOM) and `/proc/<pid>/cwd` no longer exists, there is no positive process resolution path. The node stays `launch-unknown` indefinitely; the graph stays blocked.
**Recommendation:** Define a bounded `launch-unknown` resolution protocol: if the process cannot be proven alive or dead after a configurable window, the user may explicitly dismiss the ambiguity via a dedicated action (e.g., "Discard unknown process") that releases leases and allows retry or replan.

### H5. `termination-unknown` when worktree is removed
**Section:** Agent Transport Boundary / Node Model
**Issue:** If the worktree was removed between launch and termination check, `/proc/<pid>/cwd` returns an error or `(deleted)`. The lease is held on a canonical worktree that no longer exists, and no process can satisfy the termination check. Permanent deadlock.
**Recommendation:** Define a fallback resolution order: (1) check pid-alive via `kill(pid, 0)`; (2) check process start time against recorded `started_at`; (3) if worktree directory is gone AND pid is unresponsive, treat as `terminated-by-removal` that releases leases and allows replan.

### H6. `stageResume` will incorrectly clear `approach-graph-failed` blocks
**Section:** Failure Semantics
**Issue:** The existing `stageResume.ts` checks `block.kind !== 'awaiting-merge'` and then unconditionally calls `clearStageBlock`. It would happily clear an `approach-graph-failed` block, leaving the ticket at `impl` with no active graph and no evidence of what happened.
**Recommendation:** `stageResume.ts` must be updated to check the block kind against `approach-graph-failed` and refuse to clear it, returning a distinct result. This is a mandatory compatibility change that must ship with the graph runtime.

### H7. `AgentTransport` vs `AgentAdapter` interface gap
**Section:** Agent Transport Boundary
**Issue:** `AgentTransport` introduces a new parallel interface to `AgentAdapter` without specifying how the existing adapter registry maps to it. `AgentAdapter.buildInteractiveCommand` returns a static command + env; `AgentTransport.start` returns a `SupervisedAgentSession` with lifecycle hooks. These are fundamentally different contracts.
**Recommendation:** Define a `SupervisedCLITransport` that wraps `AgentAdapter.buildInteractiveCommand`, owns process spawn/supervision, and satisfies `AgentTransport`. This bridge must be the ONLY integration point between the two interfaces.

### H8. Graph CLI verbs not isolated from `parseStageArgs`
**Section:** Module and Dependency Boundaries
**Issue:** `karst graph submit` and `karst node complete` share the same `src/cli/main.ts` dispatch entry point as `karst stage`. `parseStageArgs` is a narrow security-critical parser. There is no specification of how the new verbs are isolated at the module level.
**Recommendation:** Separate `src/cli/graph.ts` and `src/cli/nodeComplete.ts` with their own parse functions that do NOT import `stage.ts` or `machine.ts`. Add a TypeScript-level import boundary test (like `diagnostics/nonInterference.test.ts`).

### H9. `approach_graph_runs` FK behavior on ticket archival
**Section:** Persistence — `approach_graph_runs`
**Issue:** If `approach_graph_runs.ticket_id` has `ON DELETE CASCADE`, ticket archival silently destroys graph history that the spec declares immutable. If it omits the FK, orphaned rows survive uncontrolled.
**Recommendation:** `ticket_id` should have `REFERENCES tickets(id)` but NOT `ON DELETE CASCADE`. Graph history must survive ticket archival.

### H10. `SessionManager` 1:1 ticket-to-session model incompatible with N concurrent node runs
**Section:** Scheduler Runtime / SessionManager Integration
**Issue:** `SessionManager.terminals` is a `Map<number, TrackedSession>` — a 1:1 ticket-to-session model. The graph runtime launches multiple concurrent node runs for one ticket. The spec does not explain how N concurrent node runs coexist with this model.
**Recommendation:** Graph node sessions should bypass `SessionManager` entirely through `AgentTransport.start/terminate`. `SessionManager` remains legacy-only for non-graph approaches.

### H11. `GraphImplMarkerGuard` module ownership ambiguous
**Section:** Graph Compilation and Validation
**Issue:** The guard must call `transition()` from `machine.ts` but must not live in `src/workflow/` (which would import graph stores) nor `src/graph/` (which would import the machine). Either direction violates a stated invariant.
**Recommendation:** The guard must live in a thin module (e.g., `src/workflow/graphMarkerGuard.ts`) owned by `extension.ts` composition — the ONLY file with bidirectional access.

### H12. Built-in approach not reconciled with disk-based `reconcileApproachEnabled`
**Section:** Built-In Approach Lifecycle / Package Delivery
**Issue:** `reconcileApproachEnabled` reads `listInstalledIds()` from disk. The built-in approach ships in the VSIX and is NOT installed to disk via the normal path. `listInstalledIds()` won't see it, so `reconcileApproachEnabled` could disable it on any install/uninstall event.
**Recommendation:** `listInstalledIds()` must include the built-in approach when enabled. The built-in package must be materialized to a known path at extension startup.

### H13. Analyzer-only selection rule unimplementable without host-side `pickerTouched` flag
**Section:** Selection and Enablement
**Issue:** The spec says "Analyzer output may set the picker only when there is no persisted choice and the user has never touched the picker." But `setApproach` in the host does not distinguish "analyzer-set" from "user-set." There is no `touched` guard.
**Recommendation:** Add a `pickerTouched: boolean` flag to the ticket form state and gate the analyzer's `setApproach` call on `!pickerTouched && !existingPersistedChoice`.

### H14. `defaultApproach` contradicts "no fallback" rule
**Section:** Selection and Enablement
**Issue:** `defaultApproach` returns the `recommended` approach or the first one in the list as the pre-selected default in create mode. The spec says "without analyzer selection, the user chooses an approach manually; there is no 'recommended or first approach' fallback."
**Recommendation:** Clarify whether the built-in graph approach should be `recommended: true` (matching existing code default) or whether `defaultApproach` must change.

---

## Medium

### M1. `karst node replan/block` capability validation unspecified
**Section:** Immutable Replanning / Completion CLI
**Issue:** `karst node complete` validates the capability hash, but `karst node replan` and `karst node block` are described as accepting only `--reason <text>` with no mention of capability validation. A compromised agent could force replanning up to the budget.
**Recommendation:** Explicitly state that all `karst node *` verbs validate the per-run capability hash and node-run identity from host environment before accepting any mutation.

### M2. Completion capability plaintext exposed to LLM prompt injection
**Section:** Completion CLI and Trust Boundary
**Issue:** The capability lives in the supervised process's environment variables, which the agent LLM can read via tool calls (`env`, `printenv`, `/proc/self/environ`). A prompt-injected agent could exfiltrate the capability.
**Recommendation:** Pass the capability via a file descriptor or Unix domain socket rather than an environment variable, or add it to the set of values the agent CLI redacts from all tool outputs.

### M3. Replan-during-drain can introduce new resource conflicts against active work
**Section:** Parallel Scheduling and Resource Claims
**Issue:** Revision N+1's planner could generate resource claims conflicting with still-draining revision-N leases. Those nodes hold leases that cannot be released until they finish, creating a temporary livelock bounded only by wall-time ceilings.
**Recommendation:** Revision N+1's compilation should validate resource claims against the set of still-draining revision-N leases and defer or reject conflicting nodes.

### M4. Loopback callback URL predictable, spam not rate-limited
**Section:** Completion CLI and Trust Boundary
**Issue:** The callback URL is derivable from graph run identity. A malicious agent could spam the endpoint to trigger repeated coordinator wake-ups. Rate-limit threshold and backoff strategy are unspecified.
**Recommendation:** Specify a per-graph-run rate limit (e.g., max 1 wake-up per N seconds with exponential backoff).

### M5. Fork instance lineage propagation undefined for nested forks
**Section:** Join Model / Fork Instance Lineage
**Issue:** The document does not specify how `fork_instance_id` values are generated or how lineage is propagated through intermediate nodes. A deeply nested fan-out could lose or corrupt lineage, causing joins to never be satisfied.
**Recommendation:** Specify `fork_instance_id` generation strategy (e.g., UUIDv7 or composite key). Define lineage propagation rules for nested fan-out.

### M6. `BEGIN IMMEDIATE` contention retry behavior unspecified
**Section:** Parallel Scheduling / Resource Claims
**Issue:** Under multi-window contention, two windows attempting to claim tokens will both open `BEGIN IMMEDIATE` transactions; one gets `SQLITE_BUSY`. Retry behavior (backoff, count, yield) is unspecified.
**Recommendation:** Specify WAL mode. Define bounded retry with exponential backoff; yield and re-reconcile on next wake-up if retry exhausts.

### M7. Causal lineage tracking for artifact instances across replans undefined
**Section:** Persistence — `approach_artifact_instances`
**Issue:** After a replan creates revision N+1, a consumer node resolving "newest successful" could accidentally bind to an artifact from the superseded revision N. How causal lineage is tracked at the persistence level is unspecified.
**Recommendation:** Add a `causal_lineage` structure or document precisely how the runtime derives causal lineage from token predecessor graphs.

### M8. Surrogate PK type not specified per table
**Section:** Persistence — Surrogate ID PK consistency
**Issue:** The spec does not specify `INTEGER PRIMARY KEY` (rowid alias) vs `INTEGER PRIMARY KEY AUTOINCREMENT`. For graph runs/revisions, rowid alias gives insertion-order identity. For tokens where cancelled rows could cause rowid reuse, AUTOINCREMENT is needed.
**Recommendation:** Explicitly declare the PK type for each new table.

### M9. `phase_marks` coexistence with graph runtime underspecified
**Section:** Persistence / `phase_marks` Retirement
**Issue:** The spec says `phase_marks` "remains historical UI evidence for legacy approaches" but does not clarify whether graph approaches stop writing `phase_marks` entirely, or both systems coexist.
**Recommendation:** State that graph-runtime tickets write NO `phase_marks` rows. Graph tables are the authoritative evidence.

### M10. Schema migration cross-window lock undefined
**Section:** Persistence — Schema migration
**Issue:** The spec says "atomic under a cross-window migration lock" but the existing `migrate()` function has no such lock. If window A starts a migration and window B opens before A commits, B sees a partially-migrated schema.
**Recommendation:** Either use `BEGIN IMMEDIATE` at migration start (existing pattern, just document it), or define an explicit advisory-lock mechanism. Also specify that graph CLI write paths must acquire this lock.

### M11. Canonical JSON SHA-256 verification across serializer versions
**Section:** Persistence — Canonical JSON
**Issue:** If the JSON serializer library changes versions, the same logical graph could produce different canonical bytes, causing fingerprint mismatch on reload.
**Recommendation:** Store canonical bytes themselves (not just hash). Pin the canonicalization library version. Add test that canonical output of a reference graph does not change across upgrades.

### M12. `approach_node_overrides` CAS gap — no status column
**Section:** Persistence — Node overrides
**Issue:** The table has `row version and updated timestamp` but no `status` column to compare against. An override could be written after claiming has begun if the version happens to still match.
**Recommendation:** Add a `status` column or document that the CAS is on the node run's status, not the override row.

### M13. Join arrival correlation incomplete for loop iterations
**Section:** Persistence — Token join correlation
**Issue:** `fork_instance_id` alone does not distinguish two arrivals from the same predecessor forked at different loop iterations. A join could consume an arrival from a prior iteration.
**Recommendation:** Include both `fork_instance_id` and a `visit_generation` or `iteration` counter in join correlation.

### M14. In-flight agent sessions during VS Code window reload
**Section:** Reload/Multi-Window Recovery
**Issue:** When VS Code reloads the window, the old extension host is destroyed. The old supervised process's PID is in the DB, but the terminal/pty handle is gone. The loopback callback URL changes on reload. The spec does not describe how the new window discovers the old process is still alive or how its completion callback is routed.
**Recommendation:** Define the reload protocol: new window probes pids from DB for `running` node runs; live pids become `termination-unknown` candidates; old process completion callback must be routed through a shared endpoint or the current window's coordinator.

### M15. Concurrent replan while planner is still running
**Section:** Immutable Replanning
**Issue:** If a planner is still running when a second replan is requested, the spec says "persist later replan requests as bounded evidence." But if the first planner submits while its revision is already superseded, the submission is for a stale revision.
**Recommendation:** A planner submission for a non-`active` revision should be an idempotent no-op: the planner run is marked `stale`, its snapshot discarded, and no revision created.

### M16. `replan` outcome + exhausted replan budget undefined
**Section:** Immutable Replanning / Budgets
**Issue:** When a node reports `replan` but `maxReplans` is exhausted, the replan election transaction fails (winner increment would exceed ceiling). What happens to the node that reported `replan` is undefined.
**Recommendation:** Node's effective outcome becomes `blocked` with reason `graph-budget-exhausted`. The graph transitions to `blocked`. Node isolation and leases retained for user inspection.

---

## Low

### L1. Resource claims can be exploited for performance denial
**Section:** Generated Graph Contract
**Issue:** A malicious planner can declare overlapping writes across unrelated nodes, forcing serial execution. No bound on unnecessary serialization.
**Recommendation:** Add a compiler check that flags resource-claim overlap ratios exceeding a threshold.

### L2. `karst node block` arbitrary reason text could mislead diagnosis
**Section:** Node Model
**Issue:** Agent under prompt injection could call `karst node replan --reason "urgent security vulnerability"` to trigger unnecessary replanning and waste expert budget.
**Recommendation:** Cap `--reason` text length and prefix agent-submitted reasons with `[agent-reported]`.

### L3. `maxParallel` does not bound agent-internal subprocess fan-out
**Section:** Budgets / `maxParallel`
**Issue:** A single agent could spawn dozens of child processes without consuming additional `maxParallel` slots, potentially exhausting system resources.
**Recommendation:** Acknowledge as known V1 limitation. Document that `maxParallel` bounds Karst-managed concurrency, not total system process count.

### L4. Multi-window deterministic ordering not globally reproducible
**Section:** Scheduler Runtime
**Issue:** Two tokens created in different windows may have creation timestamps in the same millisecond. Final scheduling order depends on commit sequence, not logical cause.
**Recommendation:** Acknowledge that multi-window reconciliation produces consistent but not globally reproducible execution order.

### L5. Draining revision successor tokens ambiguous
**Section:** Reload/Multi-Window Recovery
**Issue:** "Stop launching new nodes from that revision" is ambiguous for successor tokens emitted by nodes that complete during draining.
**Recommendation:** Clarify that successor tokens from draining-revision nodes are suppressed (not launched).

### L6. Hard ceilings uncalibrated against real VS Code usage
**Section:** Budgets / Hard ceilings
**Issue:** `maxParallel <= 8`, 72h graph lifetime, 8h agent wall time are not justified against VS Code's typical extension host resources.
**Recommendation:** Provide rationale for defaults targeting a specific hardware profile. Default `maxParallel` to 4.

### L7. Settings list incomplete
**Section:** Settings and Graph UI
**Issue:** Missing from settings list: prompt override editor, per-node override editor, artifact/resource constraints, wall-time budgets.
**Recommendation:** Expand settings list with named "Budgets" subsection.

### L8. `approaches:` array merge by `id` not specified
**Section:** Configuration Model
**Issue:** Array merge by index is undefined. The spec does not define lookup-by-id merge strategy.
**Recommendation:** State that the `approaches:` array is merged by `id` key, not by position.

---

## Informational

### I1. Capability hash is one-shot by consumption — revocation documented implicitly
**Section:** Security Invariants
**Recommendation:** Document that capability hash validation is one-shot per node-run (consumed on first valid completion) for explicitness.

### I2. `GraphImplMarkerGuard` is NOT a graph event
**Section:** Security Invariants
**Recommendation:** Add clarifying sentence that the guard runs after graph quiescence, authored by the host, not by the graph runtime.

### I3. Stage block writes for `approach-graph-failed` must use existing infrastructure
**Section:** Verification Strategy
**Recommendation:** Confirm stage block writes use `parkGateStage`/stage-block infrastructure, never direct `UPDATE stages`.

### I4. Canonical graph JSON in DB is bounded by compilation limits
**Section:** Artifacts and Context Policy
**Recommendation:** Clarify that canonical graph JSON is the validated/default-expanded document, bounded by `maxNodeRuns <= 200`.

### I5. `confirmGeneratedGraph` value proposition unclear vs Stop mechanism
**Section:** confirmGeneratedGraph Policy
**Recommendation:** Either cut from V1 and rely on Stop, or name the user scenario where Stop is insufficient.

### I6. Delivery slice dependencies not fully enumerated
**Section:** Delivery Strategy
**Recommendation:** For each slice, state: (a) which prior slice's API it depends on, (b) which API it extends, (c) whether it must be designed for parallel from start.

### I7. Abandoned `karst-two-phase` cleanup timing unspecified
**Section:** Built-In Approach Lifecycle
**Recommendation:** Specify cleanup as build-time/CI step, not runtime activation step.

### I8. Per-slice plan output location unspecified
**Section:** Delivery Strategy
**Recommendation:** Name expected output location (e.g., `.planning/karst-graph-engineering/`).

---

## Recommended Priority

1. **Fix Critical (C1–C3) and High (H1–H14) before implementation planning.** These are design-level gaps that would cause correctness or security failures.
2. **Address Medium (M1–M16) during slice 1–2 planning.** Most are schema/interface definition gaps that block clean implementation.
3. **Track Low (L1–L8) and Informational (I1–I8) as implementation-time polish.** None block slice 1.
