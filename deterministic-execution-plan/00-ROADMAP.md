# Dynamic IMPL Graph Runtime — Implementation Roadmap

> **Design of record:** [`docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md`](../docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md) (post-remediation, commit `41cc326`).
> **Binding decisions:** [`docs/plans/2026-08-10-graph-runtime-review-remediation.md`](../docs/plans/2026-08-10-graph-runtime-review-remediation.md) — "Key Decisions" 1–31. This plan may not reopen any of them.
> **Findings ledger:** [`docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md`](../docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md) — 119 review findings, all dispositioned.

## Goal

Implement the dynamic IMPL graph runtime in `src/`, in six sequenced vertical slices, so that at the end of every slice:

- the repository typechecks, builds, and passes `npm test`;
- every existing non-graph approach launches, marks, settles, and ships exactly as it does today;
- no invariant listed in [`99-INVARIANT-CHECKLIST.md`](./99-INVARIANT-CHECKLIST.md) is weakened by a later slice.

The delivered plan must carry **no High or Critical defect class** from the three design reviews. The mechanism for that is not diligence: every one of those classes is bound to a named task and a named test in this plan, and [`99-INVARIANT-CHECKLIST.md`](./99-INVARIANT-CHECKLIST.md) is the pass/fail gate run before each slice is called done.

## Documents in this plan

| File | Contents |
|---|---|
| `00-ROADMAP.md` | This file: verified current state, slice sequence, gates, executor rules |
| `01-slice-1-package-and-configuration.md` | Built-in package, manifest pipeline, overlay seam, effort metadata |
| `02-slice-2-durable-planning-and-compilation.md` | Migration, stores, parser/compiler, planner run + submission CLI |
| `03-slice-3-sequential-execution-and-guarded-completion.md` | Executors, transport, integration, marker guard, enable flip |
| `04-slice-4-loops-recovery-replan.md` | Repeated visits, causal binding, crash matrix, replan election |
| `05-slice-5-safe-parallel-execution.md` | Workspaces, leases, fork lineage, `maxParallel > 1` |
| `06-slice-6-transport-and-observability.md` | ACP transport, interactive usage per invocation, diagnostics |
| `99-INVARIANT-CHECKLIST.md` | The reviewer's gate: every High/Critical class → task → test |

## Verified current state

**Citation convention.** Facts below cite a file and, where the line is not itself the fact, a symbol. Line numbers drift with unrelated commits and a stale number reads as a false claim about the repository — the defect class the design's own citations hit. Every line number in this table was read from the tree at plan time; an executor who finds one moved re-anchors on the symbol and continues, and stops only if the **fact** is false.

Every fact below was read from the working tree at plan time. A task that depends on one of these cites it; if the executor finds it false, that is a stop-and-report blocker (Executor Rules, below), never an improvisation.

| Fact | Evidence | Consequence for the plan |
|---|---|---|
| `SCHEMA_VERSION = 34` | `src/store/migrations.ts:9` | The design text says "bumped from its current 33". **The design is stale by one.** Slice 2 bumps 34 → 35 and updates every hardcoded `user_version` assertion in `src/store/db.test.ts`. |
| `migrate()` has no outer transaction; each guarded step autocommits | `src/store/migrations.ts:90-…` | Slice 2 Task 1 introduces the `BEGIN IMMEDIATE`-wrapped step for the graph migration only, per Decision 21; it does not retrofit older steps. |
| `resumeBlockedStage` returns `boolean` | `src/workflow/stageResume.ts:31-36` | Slice 3 widens it to a discriminated result; every caller updates in the same commit. |
| `TICKET_CHILD_TABLES` is 7 tables; `deleteTicket` detaches `token_usage` first, then deletes `review_findings`, `process_runs`, the child tables, the ticket | `src/store/tickets.ts:484-546` | Slice 2 Task 8 inserts the eight graph tables into that explicit sequence after `process_runs`, per Decision 22. No `ON DELETE CASCADE` is added. |
| `ModelOption` is exactly `{id, label, providers}` | `src/agent/modelCatalog.ts:3-9` | Slice 1 adds `efforts?: readonly string[]` and mirrors it into `model-catalog.json`, pinned by the existing equality test. |
| `validateApproaches` constructs a fresh object (drops unknown keys) | `src/manifest/schema.ts:89` | Slice 1 Task 2 extends it; without that, a `graph:` block is destroyed on the first load→save cycle. |
| `SECTION_FIELDS.approaches === ['approaches']` | `src/ui/settings/sections.ts:60` | Unchanged — this is why the config is one nested `graph:` key (Decision 4). |
| `listInstalledApproachIds` is defined in `extension.ts:1301` and injected into settings deps | `src/extension.ts:1301,1466,1605`; `src/ui/settings/actions.ts:59` | Slice 1 Task 3 makes it include enabled built-in ids at that one definition site. |
| `AI_CALL_SITES` is a closed array | `src/agent/aiCallSites.ts:18-46` | Slice 3 adds exactly two members: `graph-planner`, `graph-node`. |
| **No `karst-two-phase` package exists** anywhere in the tree or the index | `git ls-files \| grep two-phase` → empty | The design's "retire the abandoned `karst-two-phase` package" obligation is **already satisfied**. Slice 1 Task 1 records this as verified-and-no-op rather than stopping on a missing file. |
| `.karst-plugin/` is gitignored while `.karst-plugin/karst/**` and `.karst-plugin/rpi/**` are tracked | `.gitignore`; `git ls-files` | Slice 1 Task 1's CI check must treat "tracked" as the criterion, not "unignored", or it fails on today's tree. |
| WAL is enabled at open | `src/store/db.ts:22` | Stated as an existing fact. No task enables it. |
| Build is `clean && tsc -p tsconfig.build.json && node scripts/copy-assets.mjs` | `package.json` scripts | Slice 1 Task 1 extends `scripts/copy-assets.mjs` to copy the built-in package into `dist/`. |

## Slice sequence and gates

Slices run in order. A slice's **entry gate** must hold before its first task; its **exit gate** before the next slice starts.

| Slice | Entry gate | Exit gate |
|---|---|---|
| 1 — Package & configuration | none | Built-in resolves through `withBuiltInApproaches` in all three consumers; manifest round-trips a full `graph:` block; effort metadata pinned; package bytes in VSIX match Git; built-in ships `enabled: false` and is invisible to picker/analyzer/launch |
| 2 — Durable planning & compilation | Slice 1 exit | Migration atomic and idempotent; eight tables + `token_usage` FKs present; parser/compiler pure and total; canonical fingerprint pinned; planner run + `karst graph submit` guarded; Inside read-only projection behind a flag |
| 3 — Sequential execution & guarded completion | Slice 2 exit **and** the recorded cost comparison of the design's Premise and Measurement section | Executors run at `maxParallel: 1`; supervised transport with proven termination; integration into canonical worktrees; guarded IMPL marker; graph-aware Resume; packaged default flips to `enabled: true` |
| 4 — Loops, recovery, replan | Slice 3 exit | Repeated visits with distinct identities; causal artifact binding; full crash matrix green; replan election single-winner; revision N+1 |
| 5 — Safe parallel execution | Slice 4 exit | Isolated workspaces; durable leases; fork lineage; deterministic integration; multi-window races green; packaged `maxParallel` 1 → 4 |
| 6 — Transport & observability | Slice 5 exit **and** the post-Slice-3 measurement evaluated as favorable under the design's abandonment criterion | ACP optional transport; per-invocation interactive usage; structured diagnostics — with **zero** scheduler-semantics change |

**Abandonment gate (binding).** The design's success criterion is evaluated after Slice 3 on N real tickets across implementation wall time, total token cost, human-intervention count, and UAT-pass-on-first-attempt. If the graph does not improve at least one without worsening the others, the approach ships **disabled** and Slices 4–6 are not built. Slice 3's final task records that measurement; it is not optional work that can be deferred into "later".

## Cross-slice invariants

These hold from the first commit of Slice 1 to the last commit of Slice 6. A slice that would weaken one stops instead.

1. **The graph exists only inside `impl`.** No graph module imports `src/workflow/machine.ts` or `graph.ts`; no graph event produces a `Verdict`. The only stage integration is the three surfaces owned by `src/workflow/graphMarkerGuard.ts` (marker guard, `approach-graph-failed` block write/clear, typed recovery action from `stageResume`).
2. **Karst owns routing.** No agent-authored string ever names a node, edge, destination, provider, model, effort, capability, generation, or path. Agent `blocked`/`replan` are the single documented exception and are budget-bounded self-reports that cannot advance a stage.
3. **Every mutation that could double-spend is a single `BEGIN IMMEDIATE` transaction with an affected-row check.** Claim, join firing, completion, replan election, END quiescence + status flip, marker close, discard-unknown-process.
4. **Nothing blocks the extension-host event loop.** No `spawnSync` on any graph path; a contended `BEGIN IMMEDIATE` in the host aborts immediately and is retried on the sweep.
5. **Untrusted input is parsed by a closed parser at every boundary** — planner `graph.json`, CLI argv, environment identity claims, agent reason text. Unknown fields are rejected, never ignored; numbers are finite safe integers inside explicit ranges.
6. **The capability hash is the sole authenticator.** Environment identity fields are untrusted claims; the conditional UPDATE matching project, ticket, stage attempt, graph, revision, run id, generation, status, and capability hash is what makes them safe.
7. **Evidence is written when it happens**, not batched to the end of a run — the `stage_runs` lesson (869edna84). A host that dies mid-graph keeps every artifact instance, node run, and outcome already produced.
8. **Nothing karst generates lands inside a worktree.** Artifact roots and node workspaces live under global storage; no `KARST_EXCLUDE_RULES` entry is added for them, and that is the reason, not an omission.
9. **Non-graph behavior is untouched.** Every slice runs the full existing suite; a diff to a non-graph behavior test is a defect, not a rebaseline.
10. **Token accounting stays at one seam per mode** — headless via `instrumentedAdapter`, interactive via `process_runs` + the existing sampler. No second ledger.

## Executor rules

Identical in force to the remediation plan's rules, restated because this plan is executed by a different agent:

1. Execute tasks strictly in numerical order within a slice, and slices in order.
2. Complete a task's verification before starting the next.
3. Implement exactly what is described. Do not redesign, substitute an approach, add features, refactor opportunistically, or reinterpret requirements.
4. TDD is mandatory and is the repository's rule: write the failing test first (RED), then the minimal implementation (GREEN), then refactor. A task whose test was written after the implementation is not complete.
5. Run the verification specified for every task; mark complete only when its completion criteria hold.
6. Stop and report rather than improvise. Report: slice, task number, the exact blocker, the evidence, which plan assumption is invalid, and the minimum planning decision required to continue. Do not propose or implement an alternative unless asked to re-plan.

Legitimate blockers: a referenced file/API does not exist; repository state materially contradicts a fact in "Verified current state"; the prescribed implementation is technically impossible; two instructions contradict; verification proves a fundamental assumption false.

## Commit convention

One commit per task, conventional commits, scoped `feat:`/`test:`/`refactor:`/`docs:`. A commit that exists to satisfy a UI rule cites the rule id (UI-R##). No commit mixes a graph task with an unrelated repository change.
