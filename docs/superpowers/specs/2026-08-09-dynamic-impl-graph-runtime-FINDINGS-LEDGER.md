# Dynamic IMPL Graph Runtime — Findings Ledger

**Source reviews:**
- [2026-08-09-dynamic-impl-graph-runtime-REVIEW.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW.md) — 49 findings (3 Critical, 14 High, 16 Medium, 8 Low, 8 Informational). The file's own header states "42 findings (…, 1 Informational)"; that count is wrong. `grep -cE '^### (C|H|M|L|I)[0-9]+'` against the file returns 49, with I1 through I8 present. REVIEW.md itself is left uncorrected below — it is a record of what the reviewer produced, not a live document — and this ledger carries the correction instead.
- [2026-08-09-dynamic-impl-graph-runtime-REVIEW-2.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW-2.md) — 61 findings (1 Critical, 15 High, 26 Medium, 15 Low, 4 Informational)
- [2026-08-09-dynamic-impl-graph-runtime-REVIEW-3.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW-3.md) — 9 findings (4 High, 3 Medium, 2 Low)

Total: **119 findings** (49 + 61 + 9).

**Remediation plan:** [docs/plans/2026-08-10-graph-runtime-review-remediation.md](../../plans/2026-08-10-graph-runtime-review-remediation.md)

**Dispositions:** 108 accepted (each closed by a task in the remediation plan, Tasks 2–17), 3 rejected with evidence, 8 already addressed in commit `0041e79`.

---

## Verified Repository Facts

The evidence base for every rejection below. Facts verified against source during planning; reproduced verbatim from the remediation plan's Current State section.

**Design document**
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — 1128 lines, last hardened in commit `0041e79`.
- Three review files exist and are linked from its header: `-REVIEW.md` (49 findings, per `grep -cE '^### (C|H|M|L|I)[0-9]+'`; its own header wrongly says 42), `-REVIEW-2.md` (61), `-REVIEW-3.md` (9).
- No `src/` code for the graph runtime exists. Nothing in this plan changes `src/`.

**Manifest pipeline** (`src/manifest/`)
- `ApproachDef` (`types.ts:134-143`) has exactly: `id`, `label`, `description?`, `entrypoint?`, `source?`, `recommended?`, `workflow?`, `enabled?`. No `planner`/`profiles`/`commands`/`graph`.
- `validateApproaches` (`schema.ts:89-127`) calls `requireString(a.label, …)` — a `{id, enabled:false}` tombstone **throws** `ManifestError`. Unknown keys are silently dropped (the function constructs a fresh object).
- `writeManifest` (`write.ts:158`) passes `approaches` through whole (`manifest.approaches ?? []`), so it round-trips whatever the validator produced — i.e. it drops the same unknown keys.
- `SECTION_FIELDS.approaches = ['approaches']` (`ui/settings/sections.ts:58`).

**Approach machinery**
- `defaultApproach` (`ui/ticketForm/state.ts:134-138`) returns `recommended ?? approaches[0]`.
- `toApproachRows` (`state.ts:152-158`) filters `enabled !== false` then `source === undefined || installedIds.has(id)` — **a sourceless (built-in) approach is always offered without being installed**.
- `reconcileApproachEnabled` (`ui/settings/actions.ts:178-180`) is called from exactly two places (`actions.ts:263`, `actions.ts:284`) — the install and uninstall handlers — always with **that same approach's id**. It is not a global sweep.
- `setApproachEnabled` (`actions.ts:330-345`) errors `Unknown approach "<id>"` when the id is absent from `manifest.approaches`, and its install guard is `enabled && approach.source && !installed` — sourceless approaches are always enable-able.
- `syncApproachEnabled` (`actions.ts:182+`) also returns early when the id is absent from `manifest.approaches`.

**Store**
- `SCHEMA_VERSION = 33` (`src/store/migrations.ts:9`).
- `migrate()` (`migrations.ts:90-1086`) reads `user_version`, runs guarded DDL steps that each autocommit (two inner `db.transaction(…)` uses at lines 401 and 626 only), and sets `user_version` last. **No outer transaction, no lock, no busy handling.**
- `openStore` sets `journal_mode = WAL` and `foreign_keys = ON` (`store/db.ts:22-23`). No explicit busy timeout is set.
- `TICKET_CHILD_TABLES` (`store/tickets.ts:471-479`) = `stages`, `worktrees`, `port_allocations`, `baseline_refs`, `servers`, `prs`, `ticket_attachments`; `deleteTicket` (`tickets.ts:496-533`) is an explicit ordered leaf-first delete with the ledger detached first.
- `token_usage` (`schema.sql:635-663`) columns: `id`, `project_id`, `ticket_id`, `process_run_id`, `call_site`, `provider`, `model`, token counts, `estimated`, `outcome`, `recorded_at`, `implementation_segment_id`, `interactive_usage_sample_id`. **No graph/node columns.**
- `interactive_usage_samples` (`schema.sql:705-720`) has `process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE`.
- `AI_CALL_SITES` (`agent/aiCallSites.ts:18-46`) is a closed string-literal set; `UNKNOWN_CALL_SITE = 'unknown'`.
- `phase_marks` has exactly one writer: `recordPhaseMark` (`store/phaseMarks.ts:80`), called only from `src/cli/phase.ts:4`. **The `stage impl pass` marker path writes no `phase_marks` row.**

**Runtime / process**
- `src/runtime/serverIdentity.ts` exists and owns the attribution protocol (`/proc/<pid>/cwd` → `ps -o lstart=` within tolerance → tri-state `dead`/`foreign`/`unknown`), with `canonicalPath` from `runtime/pathScope.ts`.
- `KARST_EXCLUDE_RULES` (`runtime/karstExcludes.ts:24-45`) = `/.karst/`, `/.karst-plugin/`, `/.agents/plugins/`, `/.agents/skills/karst-*/`, `/.codex/karst/`, `/.opencode/skills/karst-*/`, `/.opencode/agents/karst-*/`, plus the plugins rule. A path of the form `<agentsDir>/karst-graph-engineering/graph-planner.md` matches none of them.
- `SessionManager` (`ui/session.ts:255-256`) holds `private readonly terminals = new Map<number, TrackedSession>()` — one session per ticket id.

**Model catalog**
- `ModelOption` (`agent/modelCatalog.ts:3-10`) = `{ id, label, providers }`. **No effort/variant field anywhere in the catalog, the published `model-catalog.json`, or the feed parser.**

**Stage / CLI**
- `BlockerKind` (`model/types.ts:59-71`) = `nothing-to-run | capability-missing | no-independent-signal | boot-failed | lease-lost | awaiting-merge`.
- `resumeBlockedStage` (`workflow/stageResume.ts`) returns `boolean` and clears any block whose kind is not `awaiting-merge`.
- `src/cli/main.ts` dispatches `context`, `stage`, `phase` through separate parse modules.
- `src/cli/writableStore.ts:40-42` — the `.transaction()` shim issues plain `db.exec('BEGIN')`, with no busy timeout.

---

## Rejected

Three findings are rejected with evidence and are NOT acted on. Evidence citations are from the Verified Repository Facts above.

### R1-H12 — "`reconcileApproachEnabled` could disable the built-in on any install/uninstall event"

**Source:** REVIEW — High.

**Rejected because:** `reconcileApproachEnabled` (`ui/settings/actions.ts:178-180`) is called from exactly two places (`actions.ts:263`, `actions.ts:284`) — the install and uninstall handlers — always with that same approach's id. It is not a global sweep, so no unrelated install/uninstall event can reach the built-in. Its guard `enabled && approach.source && !installed` exempts sourceless approaches, so even on the built-in's own id the flag is never forced off. The genuine, different gap — a built-in absent from `manifest.approaches` makes `setApproachEnabled`/`syncApproachEnabled` no-op with `Unknown approach` — is REVIEW-2 H11 and is accepted (Task 3).

### R2-L7 — "graph tickets will write `phase_marks` through the marker flow"

**Source:** REVIEW-2 — Low.

**Rejected because:** `phase_marks` has exactly one writer: `recordPhaseMark` (`store/phaseMarks.ts:80`), called only from `src/cli/phase.ts:4`. The `stage impl pass` marker path writes no `phase_marks` row, and graph seeds never contain `cliStagePrefix`, so a graph ticket's guarded marker writes none by construction. The design already forbids the phase verb in graph seeds; a one-sentence statement is still added under Decision 24 (Task 11) for explicitness.

### R1-L6 — split; "default `maxParallel` to 4" clause rejected

**Source:** REVIEW — Low.

**Rejected clause:** "Default `maxParallel` to 4." The packaged default is `1`; Slice 5 raises it to `4` (Decision 8, Task 4). WAL, which REVIEW-1 M10 and REVIEW-2 M8 ask to "specify", is already enabled at `store/db.ts:22`; the design states it as an existing fact, not a new requirement.

**Accepted half:** "Hard ceilings uncalibrated against real VS Code usage" — accepted and closed by Task 4 (Ceiling rationale paragraph).

---

## Already Addressed in Commit 0041e79

These eight REVIEW-1 findings were resolved by the hardening commit `0041e79` and are present in the current design text. They are recorded here with the design section that carries the resolution and are not re-edited — except where a later decision tightens them, noted per entry.

- **R1-H2 — END quiescence detection not atomic.** `## Scheduler Runtime` — the graph status is an entry condition, never a verdict; the guarded marker transaction requires "no pending/claimed activations, unsatisfied joins, completing/integrating/active node runs, or held ambiguous-process leases" in the same transaction as the existing transition path.
- **R1-H3 — Draining revision → new revision token race.** `## Immutable Replanning` — step 6 allocates exactly one new `PlannerRun` "transactionally with quiescence"; `## Security Invariants` — "A draining or superseded revision may accept evidence but can never emit successors."
- **R1-H4 — `launch-unknown` becomes permanent when positive resolution is impossible.** `## Reload, Multi-Window, and Stale Process Recovery` — "A crash after possible spawn but before identity is `launch-unknown` and blocks"; `## Agent Transport Boundary` — "Neither is automatically retried or releases physical-resource leases." **Tightened by Task 8**: the user-initiated "Discard unknown process" action (Decision 18) is the escape from the permanent-stall class.
- **R1-H6 — `stageResume` will incorrectly clear `approach-graph-failed` blocks.** `## Failure Semantics` — "Generic `stageResume` must not clear `approach-graph-failed` by itself; it returns/routes a typed graph recovery action."
- **R1-H8 — Graph CLI verbs not isolated from `parseStageArgs`.** `## Completion CLI and Trust Boundary` — "Planner submission and node completion have separate closed parsers from each other and from `stage`"; `## Security Invariants` — "`stage`, `node`, and graph-planner submission remain separate closed CLI paths."
- **R1-H9 — `approach_graph_runs` FK behavior on ticket archival.** `## Persistence` — surrogate IDs and immutable evidence with no cascade on the new tables; Task 11's Delete policy makes the per-table `ON DELETE` contract explicit.
- **R1-H11 — `GraphImplMarkerGuard` module ownership ambiguous.** `## Module and Dependency Boundaries` — "The guarded IMPL marker service is the sole graph/stage integration point; graph/node CLI handlers may import driver-agnostic graph-store operations but never the workflow machine" (the surface list is corrected by Task 14, R2-M18).
- **R1-M1 — `karst node replan/block` capability validation unspecified.** `## Completion CLI and Trust Boundary` — the conditional UPDATE requires "project, ticket, stage attempt, graph, revision when applicable, run ID, generation, status, and capability hash" for every verb; `## Security Invariants` — "Every completion requires a run-specific unforgeable capability."

---

## Accepted

Every remaining finding is accepted and closed by one task of the remediation plan (Tasks 2–17). A finding whose fix spans two tasks is assigned to the task that states the binding decision.

| Finding | Source | Severity | Closed by task |
|---|---|---|---|
| R1-C1 | REVIEW | Critical | Task 8 |
| R1-C2 | REVIEW | Critical | Task 2 |
| R1-C3 | REVIEW | Critical | Task 6 |
| R1-H1 | REVIEW | High | Task 7 |
| R1-H5 | REVIEW | High | Task 8 |
| R1-H7 | REVIEW | High | Task 8 |
| R1-H10 | REVIEW | High | Task 9 |
| R1-H13 | REVIEW | High | Task 3 |
| R1-H14 | REVIEW | High | Task 3 |
| R1-M2 | REVIEW | Medium | Task 5 |
| R1-M3 | REVIEW | Medium | Task 10 |
| R1-M4 | REVIEW | Medium | Task 5 |
| R1-M6 | REVIEW | Medium | Task 10 |
| R1-M7 | REVIEW | Medium | Task 11 |
| R1-M8 | REVIEW | Medium | Task 11 |
| R1-M9 | REVIEW | Medium | Task 11 |
| R1-M10 | REVIEW | Medium | Task 11 |
| R1-M11 | REVIEW | Medium | Task 11 |
| R1-M12 | REVIEW | Medium | Task 11 |
| R1-M13 | REVIEW | Medium | Task 11 |
| R1-M14 | REVIEW | Medium | Task 10 |
| R1-M15 | REVIEW | Medium | Task 5 |
| R1-M16 | REVIEW | Medium | Task 4 |
| R1-L1 | REVIEW | Low | Task 15 |
| R1-L2 | REVIEW | Low | Task 5 |
| R1-L3 | REVIEW | Low | Task 4 |
| R1-L4 | REVIEW | Low | Task 10 |
| R1-L5 | REVIEW | Low | Task 5 |
| R1-L6 | REVIEW | Low | Task 4 |
| R1-L7 | REVIEW | Low | Task 2 |
| R1-L8 | REVIEW | Low | Task 2 |
| R1-I1 | REVIEW | Informational | Task 5 |
| R1-I2 | REVIEW | Informational | Task 14 |
| R1-I3 | REVIEW | Informational | Task 14 |
| R1-I4 | REVIEW | Informational | Task 11 |
| R1-I5 | REVIEW | Informational | Task 16 |
| R1-I6 | REVIEW | Informational | Task 16 |
| R1-I7 | REVIEW | Informational | Task 3 |
| R1-I8 | REVIEW | Informational | Task 16 |
| R2-C1 | REVIEW-2 | Critical | Task 2 |
| R2-H1 | REVIEW-2 | High | Task 5 |
| R2-H2 | REVIEW-2 | High | Task 6 |
| R2-H3 | REVIEW-2 | High | Task 12 |
| R2-H4 | REVIEW-2 | High | Task 7 |
| R2-H5 | REVIEW-2 | High | Task 9 |
| R2-H6 | REVIEW-2 | High | Task 8 |
| R2-H7 | REVIEW-2 | High | Task 8 |
| R2-H8 | REVIEW-2 | High | Task 10 |
| R2-H9 | REVIEW-2 | High | Task 11 |
| R2-H10 | REVIEW-2 | High | Task 11 |
| R2-H11 | REVIEW-2 | High | Task 3 |
| R2-H12 | REVIEW-2 | High | Task 13 |
| R2-H13 | REVIEW-2 | High | Task 4 |
| R2-H14 | REVIEW-2 | High | Task 17 |
| R2-H15 | REVIEW-2 | High | Task 15 |
| R2-M1 | REVIEW-2 | Medium | Task 7 |
| R2-M2 | REVIEW-2 | Medium | Task 5 |
| R2-M3 | REVIEW-2 | Medium | Task 5 |
| R2-M4 | REVIEW-2 | Medium | Task 8 |
| R2-M5 | REVIEW-2 | Medium | Task 10 |
| R2-M6 | REVIEW-2 | Medium | Task 10 |
| R2-M7 | REVIEW-2 | Medium | Task 4 |
| R2-M8 | REVIEW-2 | Medium | Task 10 |
| R2-M9 | REVIEW-2 | Medium | Task 11 |
| R2-M10 | REVIEW-2 | Medium | Task 8 |
| R2-M11 | REVIEW-2 | Medium | Task 11 |
| R2-M12 | REVIEW-2 | Medium | Task 11 |
| R2-M13 | REVIEW-2 | Medium | Task 11 |
| R2-M14 | REVIEW-2 | Medium | Task 11 |
| R2-M15 | REVIEW-2 | Medium | Task 10 |
| R2-M16 | REVIEW-2 | Medium | Task 3 |
| R2-M17 | REVIEW-2 | Medium | Task 15 |
| R2-M18 | REVIEW-2 | Medium | Task 14 |
| R2-M19 | REVIEW-2 | Medium | Task 14 |
| R2-M20 | REVIEW-2 | Medium | Task 14 |
| R2-M21 | REVIEW-2 | Medium | Task 2 |
| R2-M22 | REVIEW-2 | Medium | Task 2 |
| R2-M23 | REVIEW-2 | Medium | Task 2 |
| R2-M24 | REVIEW-2 | Medium | Task 4 |
| R2-M25 | REVIEW-2 | Medium | Task 2 |
| R2-M26 | REVIEW-2 | Medium | Task 4 |
| R2-L1 | REVIEW-2 | Low | Task 5 |
| R2-L2 | REVIEW-2 | Low | Task 5 |
| R2-L3 | REVIEW-2 | Low | Task 5 |
| R2-L4 | REVIEW-2 | Low | Task 15 |
| R2-L5 | REVIEW-2 | Low | Task 11 |
| R2-L6 | REVIEW-2 | Low | Task 11 |
| R2-L8 | REVIEW-2 | Low | Task 11 |
| R2-L9 | REVIEW-2 | Low | Task 14 |
| R2-L10 | REVIEW-2 | Low | Task 9 |
| R2-L11 | REVIEW-2 | Low | Task 9 |
| R2-L12 | REVIEW-2 | Low | Task 9 |
| R2-L13 | REVIEW-2 | Low | Task 14 |
| R2-L14 | REVIEW-2 | Low | Task 14 |
| R2-L15 | REVIEW-2 | Low | Task 11 |
| R2-I1 | REVIEW-2 | Informational | Task 11 |
| R2-I2 | REVIEW-2 | Informational | Task 16 |
| R2-I3 | REVIEW-2 | Informational | Task 13 |
| R2-I4 | REVIEW-2 | Informational | Task 16 |
| R3-H1 | REVIEW-3 | High | Task 16 |
| R3-H2 | REVIEW-3 | High | Task 15 |
| R3-H3 | REVIEW-3 | High | Task 16 |
| R3-H4 | REVIEW-3 | High | Task 7 |
| R3-M1 | REVIEW-3 | Medium | Task 16 |
| R3-M2 | REVIEW-3 | Medium | Task 4 |
| R3-M3 | REVIEW-3 | Medium | Task 16 |
| R3-L1 | REVIEW-3 | Low | Task 16 |
| R3-L2 | REVIEW-3 | Low | Task 15 |

---

## Duplicate Pairs Merged

Duplicate findings across reviews are merged: both members keep their row in the accepted table above and share a task number.

- **R1-C3 = R2-H2** — Task 6. Planner prompt snapshotting — R2-H2's late-binding phrasing is the tighter statement.
- **R1-H1 = R2-M1** — Task 7. TOCTOU between artifact validation and snapshot; R2-M1 adds the planner-submission flow.
- **R1-H10 = R2-H5** — Task 9. `SessionManager` 1:1 vs N concurrent node runs; R2-H5 adds the entry-point enumeration.
- **R1-M2 = R2-H1** — Task 5. Completion-capability plaintext exposure; R2-H1 is the same-UID sibling/rotation statement.
- **R1-M4 = R2-M3** — Task 5. Loopback callback rate limiting; R2-M3 adds token entropy, bind address, and origin check.
- **R1-M6 = R2-M8** — Task 10. `BEGIN IMMEDIATE` contention retry/liveness.
- **R1-M8 = R2-L6** — Task 11. Surrogate PK type declaration.
- **R1-M9 = R2-L7** — Task 11. `phase_marks` coexistence statement (R2-L7 is rejected as a finding; its explicitness statement is Decision 24).
- **R1-M10 = R2-H9** — Task 11. Schema-migration atomicity mechanism.
- **R3-H4 = R2-H4 (partial)** — Task 7. Workspace registry/teardown; R3-H4's disk-ceiling and reap halves are Task 7 items 5–6.

**R1-M5** is not assigned an accepted row: the plan's count of 108 accepted findings excludes it. Its content — `fork_instance_id` generation (UUIDv7) and nested-fork lineage propagation — is closed by Task 11's "Lineage" subsection (item 8), which applies R1-M5 together with R1-M7 and R1-M13; those two keep the rows.
