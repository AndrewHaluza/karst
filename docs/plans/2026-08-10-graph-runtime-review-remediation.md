# Execution Plan: Dynamic IMPL Graph Runtime — Review Remediation

## Goal

Amend `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` so that every accepted finding from the three review reports (119 findings total) is resolved in the design text, and record the disposition of every finding — accepted, rejected with evidence, or already-addressed — in a companion ledger file.

The end state is a design document that an implementation-planning pass can consume with no unresolved design decisions, plus a ledger that proves each of the 119 findings was considered and shows why the rejected ones were rejected.

## Current State

Facts established by inspecting the repository during planning. Every claim below was verified against source; the plan depends on them.

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

## Target State

The design document contains, for every accepted finding, an explicit resolved decision — no "clarify", "consider", or "either/or". Specifically it gains or rewrites: the manifest round-trip contract, the built-in registry overlay seam, corrected budget arithmetic and defaults, a hardened capability/trust boundary, a prompt-snapshot rule, a single-fd artifact protocol with a named artifact-root and workspace location outside every worktree, a process-identity protocol citing `serverIdentity.ts`, a session/launch entry-point matrix, pinned transaction shapes plus a periodic coordinator sweep, a complete persistence contract (PK types, FK/delete policy, transition maps, migration mechanism), token-usage attribution, catalog effort metadata, the `BlockerKind` ripple list, a planner→compiler repair loop, and a premise section covering the integration-doctrine tension, cost model, success criteria, and platform scope.

`docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md` exists and maps all 119 finding ids to a disposition and the task that closed them.

## Scope

### In Scope
- Editing `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md`.
- Creating `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md`.
- Adding the ledger link to the design header.

### Out of Scope
- Any change under `src/`, `scripts/`, `package.json`, `karst.yml`, or `model-catalog.json`. The design has no implementation yet; every code change named in this plan is described as a **future obligation recorded in the design**, not performed now.
- Editing the three review files. They are a dated record.
- Writing the per-slice implementation plans. This plan makes the design planning-ready; slice plans are a separate later deliverable.
- Re-reviewing the design for new findings.

## Key Decisions

Each numbered decision resolves one or more findings and is binding on every task below.

1. **The deliverable is documentation.** All 119 findings are design defects; none can be "fixed" in code because no graph-runtime code exists. Every accepted finding becomes a design amendment plus, where relevant, a named future code obligation inside the design text.
2. **Rejected findings.** Three findings are rejected with evidence and are NOT acted on:
   - **REVIEW-1 H12** ("`reconcileApproachEnabled` could disable the built-in on any install/uninstall event") — false: it is called only from the install and uninstall handlers with that same approach's id (`actions.ts:263,284`), and its guard `enabled && approach.source && !installed` exempts sourceless approaches. The genuine, different gap (a built-in absent from `manifest.approaches` makes `setApproachEnabled`/`syncApproachEnabled` no-op with `Unknown approach`) is REVIEW-2 H11 and is accepted.
   - **REVIEW-2 L7** ("graph tickets will write `phase_marks` through the marker flow") — false: the only writer is `recordPhaseMark`, reachable only from `karst phase`. The design already forbids the phase verb in graph seeds. A one-sentence statement is still added under Decision 24 for explicitness.
   - **REVIEW-1 L6's "Default `maxParallel` to 4"** — superseded by Decision 8. WAL, which REVIEW-1 M10 and REVIEW-2 M8 ask to "specify", is already enabled at `store/db.ts:22`; the design states it as an existing fact, not a new requirement.
3. **Already-addressed findings.** REVIEW-1 H2, H3, H4, H6, H8, H9, H11 and M1 were resolved by commit `0041e79` and are present in the current text. They are recorded in the ledger as `already-addressed` with the design line that carries them, and are not re-edited — except where a later decision here tightens them (H4 by Decision 15, H2 by Decision 18).
4. **Manifest shape.** `ApproachDef` gains one optional key, `graph?: GraphApproachConfig`, holding `planner`, `profiles`, `commands`, and `graph` (the budget block is renamed `limits` to avoid `graph.graph`). The four blocks are NOT hoisted to the top level of `ApproachDef` — one nested key keeps `SECTION_FIELDS.approaches` unchanged and confines the validator work to one function.
5. **Tombstones carry a label.** `validateApproaches` keeps requiring `label`. Disable is written by a registry-aware writer that injects the built-in's packaged `label`, so the manifest never contains a labelless entry. The `approaches:` array merges by `id`, never by position.
6. **Built-in overlay seam.** One pure projection, `withBuiltInApproaches(manifest): Manifest`, sits between manifest load and every approach consumer (ticket form, settings, launch resolution). It overlays packaged built-in definitions onto `manifest.approaches` by id. `listInstalledIds()` includes every enabled built-in id. This is the single seam; no consumer learns about built-ins any other way.
7. **Selection behavior is unchanged globally.** `defaultApproach`'s `recommended ?? approaches[0]` rule stays exactly as it is, and the built-in ships `recommended: false`. The design's "no recommended-or-first fallback" sentence is deleted — it was a global behavior change that contradicted the compatibility claim. Analyzer-moves-the-pick is gated on a new host-side `pickerTouched` flag and applies only when there is no persisted choice.
8. **Concurrency defaults.** Packaged default `maxParallel: 1`. Slice 5 raises the packaged default to `4`. Hard ceiling stays `8`. A command node's per-repository subprocesses run **serially within the node**, consuming one slot at a time, so `repositories per command ≤ 20` can never make a node unschedulable.
9. **Expert budget arithmetic.** Packaged defaults become `maxExpertRuns: 5`, `maxReplans: 2`. The compile-time rule is `spent + permittedReplans + 1 (bootstrap, if unspent) + Σ maxVisits over expert-resolved agent nodes ≤ maxExpertRuns`. The example graph's `budgets` become `maxExpertRuns: 4, maxReplans: 1`.
10. **First-run posture.** `confirmGeneratedGraph` defaults to `true`. Packaged planner effort defaults to `high`, not `max`, until a cost measurement exists (Decision 26).
11. **Capability handling.** The completion capability is consumed one-shot on the **first** mutating verb (`complete`, `block`, or `replan`), and is rotated per launch attempt/generation. A same-UID sibling reading `/proc/<pid>/environ` is a documented residual risk in the threat model, not a defended boundary. Environment identity fields are untrusted claims; the capability hash is the sole authenticator.
12. **Agent prose never becomes argv.** Replan/block reasons reach the next planner only as a file artifact, framed as untrusted agent-reported text.
13. **Loopback endpoint.** Route token is CSPRNG ≥128 bits, the listener binds `127.0.0.1`, non-loopback origins are rejected, and a per-graph-run wake-up rate cap with backoff covers **valid** requests too, not only malformed ones.
14. **Prompt snapshots.** The effective planner and node-base prompt bytes (packaged overlaid with project override) are snapshotted at planner-run / node-run creation and read only from the snapshot; the launch verifies the recorded hash. The mutable on-disk file feeds the *next* run's snapshot.
15. **Artifact and workspace locations.** The per-run artifact root and every node execution workspace live under the extension's **global storage**, at `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/{artifacts,workspaces}/` — **outside every repository worktree**. Consequences: no `KARST_EXCLUDE_RULES` entry is needed for them, `ship`'s `git add -A` cannot see them, and their removal owner is explicit (Decision 22). The `<agentsDir>/karst-graph-engineering/*.md` prompt overrides remain inside the repository and are deliberately tracked user content, exactly like existing agent prompt overrides — no exclude rule is added for them either.
16. **Artifact read protocol.** Validation and copy are one operation per file: open with `O_NOFOLLOW|O_NONBLOCK`, `fstat` the opened descriptor, verify regular-file/link-count/size/type, then read from that same descriptor into content-addressed storage. The path is never re-resolved. The planner process is terminated and its termination proven **before** its submission snapshot, exactly as node completion already requires.
17. **Process identity.** `runtime/serverIdentity.ts` is the mandated evidence source and is cited by name: live cwd via `/proc/<pid>/cwd` where the OS provides it, else process start time via `ps -o lstart=` matched within `START_TIME_TOLERANCE_MS`, both sides canonicalized through `pathScope.ts`'s `canonicalPath`, producing `attributable` / `dead` / `foreign` / `unknown`. Termination signals the process **group** and checks `killTree`'s return (`killed`/`denied`/`unknown`). `unknown` maps to `termination-unknown`. A missing workspace directory is evidence only when its parent still stands.
18. **Ambiguity is escapable.** `launch-unknown` and `termination-unknown` are resolvable by one explicit user action, "Discard unknown process", implemented as a single transaction: `claimed → cancelled` on the token, node run `cancelled`, reserved graph/node/expert budget contributions released, lease released, then re-evaluate — blocking with `graph-topology-deadlock` if the edge is now unsatisfiable. This is the escape from the permanent-stall class (REVIEW-1 C1, H4, H5).
19. **Graph sessions bypass `SessionManager` entirely.** They are owned by `AgentTransport` and keyed `(ticketId, nodeRunId)`. `SessionManager` stays 1:1 and legacy-only. Every existing ticket-level launch entry point is enumerated with an explicit rule while a graph run is active.
20. **Environment keys.** `KARST_TICKET_ID` keeps its meaning. `KARST_LAUNCH_ID` carries the **node-run id** for graph sessions, so `ui/terminalIdentity.ts` keeps working unchanged. Graph-specific values are added as new `KARST_GRAPH_*` names. Hooks are diagnostics-only: graph scheduling never reads hook delivery.
21. **Liveness.** A bounded periodic coordinator reconciliation sweep rides the existing background PR sweep in `extension.ts`. A busied `BEGIN IMMEDIATE` aborts immediately (no synchronous block of the extension-host event loop), counts nothing, and is retried on the next sweep. The CLI's `writableStore` shim is upgraded to `BEGIN IMMEDIATE` plus a busy timeout for graph verbs.
22. **Persistence contract.** All eight tables use `INTEGER PRIMARY KEY` (rowid alias); AUTOINCREMENT is deliberately absent because every table is append-only. `approach_graph_runs.ticket_id REFERENCES tickets(id)` with **no** cascade; `deleteTicket` gains the eight tables in leaf-first order after `process_runs` and before the older child tables, and also deletes the ticket's artifact/workspace bytes under the Decision-15 root. Archive (a soft delete) never removes graph history or bytes. No per-ticket pruning in V1.
23. **Derived state, not stored.** `approach_graph_runs.active_revision_id` is dropped; the active revision is derived by reading `approach_graph_revisions WHERE status = 'active'`, following the `merge_checks` read-filtered precedent. Canonical bytes are authoritative on reload; the stored fingerprint is verified on read and a mismatch blocks.
24. **`phase_marks`.** Graph tickets write none, because the only writer is `karst phase` and graph seeds never contain it. Stated in one sentence; no code change.
25. **Token accounting.** Every graph launch opens a `process_runs` row, which the existing interactive usage sampler binds to — so there is exactly one interactive accounting seam, not two. `token_usage` additionally gains nullable `approach_planner_run_id` and `approach_node_run_id` (`ON DELETE SET NULL`, detached like the rest of the ledger) in the same migration. Two new closed call sites are added: `graph-planner` and `graph-node`.
26. **Catalog effort metadata.** `ModelOption` gains one optional field, `efforts?: readonly string[]`, mirrored into `model-catalog.json` and pinned by the existing `modelCatalog.test.ts` equality test. A model with no `efforts` accepts no effort value. For OpenCode, effort **is** the model variant: a profile setting both `model` and `effort` for an OpenCode provider is rejected at Save.
27. **Deterministic-routing exception.** Agent `blocked` and `replan` are documented as budget-bounded self-reports and the single deliberate exception to karst's never-route-on-self-report rule. `replan` additionally requires one observable precondition in the causal lineage: a failed deterministic gate/command outcome, a `resource-claim-violated`, or an `integration-conflict`. A `replan` with no such evidence is recorded and treated as `blocked`.
28. **Planner repair loop.** A rejected graph document is returned to the same `PlannerRun` with structured compiler diagnostics, up to 3 compile attempts total per planner run, before the run fails to `graph-plan-invalid`. Attempts are counted on the planner run, not as new planner runs.
29. **Compiler purity.** Physical resource domains are resolved by the store/scheduler layer and **passed into** compilation as an injected resolved map. The compiler stays pure and imports no stores.
30. **Premise items are stated, not silently carried.** The design gains a short "Premise and Measurement" section covering: why intra-ticket integration is not the retired `merge` stage; the required cost comparison before Slice 3; the success and abandonment criteria; and the platform scope (Windows path rules are pure-string unit tests only; no Windows runtime support is asserted for V1).
31. **Slice re-sequencing.** Slice 1 ships the built-in **disabled by default**; the slice that flips it on is Slice 3, named explicitly. Slice 6's deferred items (structured diagnostics, interactive usage reporting) are marked "Slice 6" where they appear in the UI section.

## Execution Order

### Task 1: Create the findings ledger and link it from the design header

#### Objective
Produce the disposition record for all 119 findings so that later tasks can be checked for coverage, and so a reader can see why three findings were rejected.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md` — created; the disposition record.
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — modified; header gains one link line.

#### Implementation
1. Create the ledger with this structure:
   - A header naming the three source reviews, their finding counts (49 / 61 / 9 = 119), and this plan's path.
   - A "Verified repository facts" section: copy the **Current State** section of this plan verbatim, including every `file:line` citation. This is the evidence base for the rejections.
   - A "Rejected" section with exactly three entries — `R1-H12`, `R2-L7`, `R1-L6 (maxParallel default clause only)` — each carrying the rejection reason and the `file:line` evidence from Key Decision 2.
   - An "Already addressed in commit 0041e79" section listing `R1-H2`, `R1-H3`, `R1-H4`, `R1-H6`, `R1-H8`, `R1-H9`, `R1-H11`, `R1-M1`, each with the design section that carries the resolution.
   - An "Accepted" table with columns `Finding | Source | Severity | Closed by task`. Populate it with every remaining finding id from the three reviews. Use the id prefixes `R1-`, `R2-`, `R3-` for REVIEW, REVIEW-2, REVIEW-3 respectively. The `Closed by task` column takes the task number from this plan (Tasks 2–17). Every accepted finding must have exactly one task number; a finding whose fix spans two tasks is assigned to the task that states the binding decision.
   - A "Duplicate pairs merged" section listing: `R1-C3 = R2-H2`, `R1-H1 = R2-M1`, `R1-H10 = R2-H5`, `R1-M2 = R2-H1`, `R1-M4 = R2-M3`, `R1-M6 = R2-M8`, `R1-M8 = R2-L6`, `R1-M9 = R2-L7`, `R1-M10 = R2-H9`, `R3-H4 = R2-H4 (partial)`. Both members keep their row in the accepted table and share a task number.
2. Insert into the design document header, immediately after the `**Review 3:**` line, one line:
   `> **Findings ledger:** [2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md](./2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md) — disposition of all 119 review findings.`

#### Constraints
- Do not edit the three review files.
- Do not change any finding's stated severity.
- The rejection reasons must cite the `file:line` evidence given in this plan; do not re-derive them.

#### Edge Cases
- A finding whose text spans two concerns (e.g. `R2-H4` has three lettered sub-gaps) gets one row and one task number; the sub-gaps are addressed within that task.
- `R1-L6` is split: its "hard ceilings uncalibrated" half is accepted (Task 4); its "default `maxParallel` to 4" clause is rejected. Record both halves in the one row, noting the split.

#### Verification
```bash
grep -c '^| R[123]-' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md
grep -n 'FINDINGS-LEDGER' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- The first command prints `108` (119 total − 3 rejected − 8 already-addressed).
- The second prints the one new header line.

#### Completion Criteria
- [ ] Ledger file exists with all six sections.
- [ ] 108 accepted rows, each with a task number in the range 2–17.
- [ ] 3 rejected entries, each with `file:line` evidence.
- [ ] 8 already-addressed entries.
- [ ] Design header links the ledger.

---

### Task 2: Rewrite the Configuration Model section for manifest round-trip

#### Objective
Make the documented YAML shape survive the existing manifest pipeline, and close every configuration-vocabulary gap.

Closes: `R2-C1`, `R1-C2`, `R1-L8`, `R2-M21`, `R2-M22`, `R2-M23`, `R2-M25`, `R1-L7`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Configuration Model` section (currently lines ~108-210) and the `## Settings and Graph UI` settings bullet list.

#### Implementation
1. Restructure the YAML example so all graph configuration sits under one nested `graph:` key on the approach entry, with the budget block named `limits`:
   ```yaml
   approaches:
     - id: karst-graph-engineering
       label: Graph Engineering
       enabled: false          # Slice 1 ships disabled; Slice 3 flips it (Decision 31)
       graph:
         planner: { profile: expert, prompt: { artifact: skills/graph-planner/SKILL.md } }
         profiles: { … }
         commands: { … }
         limits: { confirmGeneratedGraph: true, maxParallel: 1, … }
   ```
   Apply Decisions 8, 9, and 10 to the literal default values: `maxParallel: 1`, `maxExpertRuns: 5`, `maxReplans: 2`, `confirmGeneratedGraph: true`, planner profile effort `high`.
2. Add a subsection **"Manifest pipeline obligations"** that names, as a checklist the implementation must satisfy, each file from the repo's new-manifest-field rule, with the current fact that makes it necessary:
   - `src/manifest/types.ts` — add `graph?: GraphApproachConfig` to `ApproachDef` (today it has 8 fields, none of them graph).
   - `src/manifest/schema.ts` — extend `validateApproaches` (line 89) to validate and default the block; state that it currently constructs a fresh object and therefore **drops** unknown keys, which is why an unextended validator destroys graph config on the first load→save cycle.
   - `src/manifest/write.ts` — the `approaches` overlay at line 158 passes the validated array through, so no separate overlay entry is needed once the validator preserves the block; state this explicitly so the implementer does not add a redundant overlay.
   - `src/manifest/fixtures.ts` — add the block to the shared builders.
   - `src/ui/settings/sections.ts` — `SECTION_FIELDS.approaches` stays `['approaches']` because the block is nested; state that this is why the nested shape was chosen.
   - A `writeManifest` round-trip test proving a full graph block survives load→save→load byte-identically.
3. Add a **"Merge and tombstone rules"** subsection: the `approaches:` array merges **by `id`**, never by position. Packaged defaults and project overrides merge per profile/command key; an omitted nested field inherits the packaged value; a reset removes only the explicit override. Disabling writes `{id, label, enabled: false}` — `label` is injected by the registry-aware writer, because `validateApproaches` (`schema.ts:102`) calls `requireString(a.label)` and a labelless tombstone **fails manifest load**.
4. Add a **"Settings write algorithm"** subsection resolving `R2-M22`: Settings Save serializes only the delta against the packaged built-in definition — tombstones and explicit overrides — never the merged effective object. Name the mirror obligation: the webview mirrors the delta rule and `webview.test.ts` pins it against the host's implementation, per UI-R34.
5. Enumerate the command-allowlist vocabularies (`R2-M23`), replacing the current prose:
   - `cwd`: closed set `repository` | `worktreeRoot`. No arbitrary subdirectory in V1.
   - `access`: closed set `read` | `write`.
   - `env`: a project-authored map of bounded `NAME: value` string pairs, merged onto the host-owned minimal set. The project author already supplies the executable and argv, so authoring `NODE_ENV=test` grants no new capability.
   - `timeoutSeconds`: finite safe integer, `1..7200`.
6. Add the OpenCode rule (`R2-M25`) to Execution policy resolution: for the `opencode` provider, effort **is** the model variant; a profile that sets both `model` and `effort` for OpenCode is rejected at Save with a named error. State that switching a profile's provider requires editing model and effort together.
7. Expand the Settings section bullet list (`R1-L7`) with the four missing items: prompt override editor, per-node override editor, artifact/resource constraints, and a named **Budgets** subsection covering wall-time ceilings.

#### Constraints
- Do not hoist `planner`/`profiles`/`commands`/`limits` to the top level of `ApproachDef`; Decision 4 is binding.
- Do not propose relaxing `validateApproaches`' `label` requirement.
- Keep the existing prose rule that the packaged definition ships no repository-specific command definitions.

#### Edge Cases
- A project entry that carries `graph:` for an approach id that is not the built-in: the validator accepts it (the block is generic), but no runtime consumes it. State this as accepted and inert.
- A project file containing both an old flat shape and the nested `graph:` block: refuse the load, never guess — mirroring the manifest's existing both-keys refusal for `services:`/`repositories:`.
- A tombstone for an id with no packaged definition and no prior entry: the registry-aware writer has no label to inject, so the write is refused with a named error.

#### Verification
```bash
grep -n 'maxParallel: 1' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'maxExpertRuns: 5' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'confirmGeneratedGraph: true' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Manifest pipeline obligations' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -c 'requireString' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- Each of the first four prints at least one line.
- The last prints at least `1` (the tombstone rationale cites it).

#### Completion Criteria
- [ ] YAML example uses the nested `graph:` key with `limits`.
- [ ] All five default values from Decisions 8–10 appear in the example.
- [ ] "Manifest pipeline obligations" names all five source files with their current-state facts.
- [ ] Merge-by-id, tombstone-label, and Settings-delta rules are stated.
- [ ] `cwd`/`access`/`env`/`timeoutSeconds` vocabularies are closed and enumerated.
- [ ] OpenCode model/effort conflict rule is stated.
- [ ] Settings bullet list has the four added items.

---

### Task 3: Specify the built-in registry overlay seam and selection behavior

#### Objective
Give the built-in approach a resolution path through the disk-install-based approach machinery, and restore the compatibility claim about ticket-form selection.

Closes: `R2-H11`, `R2-M21` (selection half), `R1-H13`, `R1-H14`, `R2-M16`, `R1-I7`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Selection and Enablement` section and the `## Built-In Approach Lifecycle` section.

#### Implementation
1. Replace "A host-owned `BUILT_IN_APPROACHES` registry overlays packaged definitions with project overrides by approach ID" with a specified seam:
   - Name the projection `withBuiltInApproaches(manifest: Manifest): Manifest` — pure, host-agnostic, no fs or vscode, overlaying packaged built-in definitions onto `manifest.approaches` by id.
   - Place it in the Module and Dependency Boundaries diagram between manifest load and the approach consumers.
   - State that its three consumers are the ticket form (`ui/ticketForm/state.ts`), Settings (`ui/settings/actions.ts`), and launch resolution, and that no consumer may learn about built-ins any other way.
   - State that `listInstalledIds()` includes every enabled built-in id, so `setApproachEnabled`'s install guard and `toApproachRows`' install filter both resolve.
2. Record the two current facts that make this necessary, with citations: `setApproachEnabled` (`ui/settings/actions.ts:330-336`) errors `Unknown approach` for an id absent from `manifest.approaches`; `syncApproachEnabled` (`actions.ts:182+`) returns early for the same reason.
3. Add an explicit non-finding note: `reconcileApproachEnabled` (`actions.ts:178-180`) is called only from the install and uninstall handlers with that approach's own id and its guard exempts sourceless approaches, so it cannot disable the built-in. This records the REVIEW-1 H12 rejection where a future reader will look for it.
4. Rewrite the selection bullets per Decision 7:
   - Delete "Without analyzer selection, the user chooses an approach manually; there is no 'recommended or first approach' fallback."
   - Replace with: `defaultApproach`'s existing `recommended ?? approaches[0]` rule is unchanged; the built-in ships `recommended: false`, so it is never the silent default.
   - Keep the analyzer rules, and specify the mechanism: a host-side `pickerTouched: boolean` on ticket-form state, set on any user interaction with the picker, never cleared within a form session. The analyzer may set the selection only when `!pickerTouched && ticket.approach === null`.
   - State that `state.test.ts`'s default-selection assertions and `webview.test.ts`'s analyzer-badge assertions remain valid and unchanged — the compatibility claim now holds.
5. Specify the `karst-two-phase` cleanup (`R1-I7`) as a build-time/CI step: a CI check fails when a canonical shipped package under `.agents/skills/` is git-ignored or untracked, and the abandoned package's deletion is a one-time repository commit, not a runtime activation step.

#### Constraints
- Do not change `defaultApproach`'s rule; Decision 7 is binding.
- Do not introduce a second built-in resolution path for any single consumer.
- Keep the existing rule that an explicit or persisted user choice is never overwritten.

#### Edge Cases
- A project manifest that already contains an entry with the built-in's id: the project entry wins field-by-field over packaged defaults; the overlay never discards project fields.
- A built-in disabled by tombstone: `listInstalledIds()` omits it (only *enabled* built-ins count as installed), so Settings' enable guard behaves as it does for an uninstalled sourced approach.
- Two built-ins both marked `recommended: true` in a future release: `validateApproaches` (`schema.ts:123`) already throws on more than one recommended approach — the overlay must not be able to produce that state, so packaged definitions carry `recommended: false`.

#### Verification
```bash
grep -n 'withBuiltInApproaches' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'pickerTouched' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'recommended or first approach' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- The first two print at least one line each.
- The third prints **nothing** — the contradicting sentence is gone.

#### Completion Criteria
- [ ] The overlay seam is named, placed in the dependency diagram, and its three consumers listed.
- [ ] `listInstalledIds()` includes enabled built-ins.
- [ ] The `reconcileApproachEnabled` non-finding note is present with its citation.
- [ ] The "no fallback" sentence is deleted and replaced per Decision 7.
- [ ] `pickerTouched` is specified.
- [ ] Two-phase cleanup is a CI/build step.

---

### Task 4: Correct budget arithmetic, defaults, and ceilings

#### Objective
Make the shipped defaults capable of running the behavior the design describes, and make every ceiling reachable.

Closes: `R2-H13`, `R2-M7`, `R2-M24`, `R1-L6` (accepted half), `R3-M2`, `R2-M26`, `R1-L3`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Budgets and Escalation` section, the `## Configuration Model` defaults (already changed in Task 2 — verify consistency), the example graph JSON's `budgets` object, and the `## Graph Compilation and Validation` bullet on expert budget.

#### Implementation
1. Apply Decision 9. Rewrite the compile-time expert-budget bullet to the explicit formula:
   `spentPlannerRuns + permittedReplans + (bootstrapUnspent ? 1 : 0) + Σ(maxVisits) over agent nodes whose profile resolves to `expert` ≤ maxExpertRuns`
   State that this is re-checked at replan compile against the graph-run-scoped counters, and that failing it is a compile error, not a runtime block.
2. Change the example graph's `budgets` to `{ "maxNodeRuns": 20, "maxExpertRuns": 4, "maxReplans": 1 }` and add one sentence under the example noting the arithmetic: bootstrap 1 + 1 replan reserve + up to 2 expert node visits = 4.
3. Apply Decision 8 to the CommandNode section: per-repository subprocesses of one command node run **serially within the node**, consuming one execution slot at a time. Delete any implication that they run concurrently. Keep the deterministic aggregation rule (any infrastructure fault wins, else any non-zero exit wins, else passed) unchanged. State that this is why `repositories per command ≤ 20` cannot exceed `maxParallel`.
4. Apply Decision 8 to the `maxParallel` default and add a sentence to Delivery Strategy Slice 5 that raising the packaged default from `1` to `4` is part of that slice.
5. Add a **"Ceiling rationale"** paragraph (`R1-L6` accepted half) stating the hardware profile the hard ceilings target — a developer workstation running one VS Code window — and, for each of `maxParallel <= 8`, graph lifetime `<= 72h`, and agent wall time `<= 8h`, one sentence naming what it protects against. State plainly that these are conservative first-release bounds intended to be revised once Decision 26's cost measurement exists.
6. Add the `maxParallel` limitation (`R1-L3`) as an explicit V1 statement: `maxParallel` bounds karst-managed concurrency (agent sessions and command subprocesses karst spawns), not the total system process count — an agent's own child processes are unbounded by it.
7. Apply Decision 10 to `confirmGeneratedGraph` and the planner effort default, and add one sentence to the Built-In Approach Lifecycle section explaining the first-run posture: the first graph run of a project pauses for review because the default is `true`; a project that trusts the flow sets it `false`.

#### Constraints
- Do not change any hard ceiling value; only the packaged defaults and the arithmetic change.
- Do not remove the "every logical node visit, including zero-token gate and join visits, counts" rule.

#### Edge Cases
- A project that sets `maxExpertRuns` below `maxReplans + 1`: this is a configuration error caught at manifest validation with a named message, not at compile time — state it in the Configuration Model section.
- A graph with zero expert-resolved nodes: the formula reduces to bootstrap + replan reserves; the default of 5 leaves headroom, which is the intent.
- A command node naming more repositories than `maxParallel`: with serial per-repo execution this is legal and simply takes longer. State this explicitly so no compile check is added.

#### Verification
```bash
grep -n 'maxExpertRuns' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'serially within the node' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Ceiling rationale' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n '"maxExpertRuns": 4' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- Every command prints at least one line; `maxExpertRuns: 3` must no longer appear anywhere.

#### Completion Criteria
- [ ] The expert-budget formula is written out and includes expert-resolved node visits.
- [ ] Example graph budgets are `20 / 4 / 1` with the arithmetic sentence.
- [ ] Per-repo command subprocesses are serial; the `maxParallel` interaction is stated.
- [ ] Packaged `maxParallel` is 1, with Slice 5 named as the change point.
- [ ] Ceiling rationale paragraph exists.
- [ ] The agent-child-process limitation is stated.
- [ ] `confirmGeneratedGraph: true` and planner effort `high` are the documented defaults.

---

### Task 5: Harden the completion capability and trust boundary

#### Objective
Close the capability lifecycle gaps and state the threat model honestly.

Closes: `R2-H1`, `R1-M2`, `R2-M2`, `R2-M3`, `R1-M4`, `R2-L1`, `R2-L2`, `R2-L3`, `R1-L2`, `R1-I1`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Completion CLI and Trust Boundary` section and the `## Security Invariants` list.

#### Implementation
1. Apply Decision 11. Rewrite the capability paragraph to state: CSPRNG ≥256 bits; only its hash in SQLite; **consumed one-shot on the first mutating verb** — `complete`, `block`, or `replan`, not `complete` alone; **rotated per launch attempt and generation**, so a capability leaked from a prior attempt is dead.
2. Add a **"Residual risks"** paragraph naming what is not defended: a same-UID sibling process can read `/proc/<pid>/environ` of a running node and obtain its plaintext capability; the invariant "never placed in artifacts" is a design intent, not an enforceable property, because the process holding the plaintext is the party that writes artifacts. State the mitigation that does hold — one-shot consumption plus per-attempt rotation bounds the window — and that read-side exfiltration by a compromised agent is outside the model entirely (`R2-L3`): writes are the only policed axis.
3. Apply Decision 12 to Immutable Replanning step 7: replan and block reasons reach the next planner as a **file artifact**, never as argv or a shell token, and the planner prompt frames them as untrusted agent-reported text. Cite the repo's existing precedent that a shell-token interpolation of agent-controlled text is the failure class being avoided. Keep the existing length cap and add that stored reasons are prefixed `[agent-reported]` in every rendering (`R1-L2`).
4. Apply Decision 13 to the loopback paragraph: route token CSPRNG ≥128 bits; listener bound to `127.0.0.1`; non-loopback origins rejected; a per-graph-run wake-up rate cap with exponential backoff that applies to **valid** requests as well as malformed and stale ones, because the URL is in every agent's environment and is inherited by every process it spawns.
5. Apply `R2-L1`: state that the environment identity fields (project, ticket, graph run, node run, generation) are **untrusted claims** supplied by whatever process invokes the CLI, and that the capability hash is the sole authenticator; the full-field conditional UPDATE is what makes the untrusted claims safe.
6. Apply `R2-L2` to CommandNode: enumerate the exact environment names a command subprocess receives — `PATH`, `HOME`, `TMPDIR`, `LANG`, and the project-authored `env` map from the allowlist entry (Task 2, item 5). State explicitly that the loopback URL, the artifact root, every capability, provider credentials, and editor tokens are excluded.
7. Add to Security Invariants: capability validation is one-shot per node run, consumed by the first mutating verb; capabilities rotate per launch attempt.

#### Constraints
- Do not propose passing the capability by file descriptor or Unix socket — the CLI is invoked by the agent as an arbitrary child process and cannot inherit a private descriptor reliably; the environment plus one-shot rotation is the chosen mechanism.
- Do not weaken the existing rule that no capability appears in argv, URLs, logs, diagnostics, or issue reports.

#### Edge Cases
- A node that calls `block` and then `complete`: the second call is an idempotent rejection because the capability was consumed by the first. State this.
- A launch retry after `failed-to-launch`: a fresh capability is minted for the new attempt and the prior hash is invalidated in the same transaction that increments the launch-attempt counter.
- A valid-but-late completion arriving after the coordinator already resolved the node through user cleanup: rejected idempotently, evidence recorded, no state change.

#### Verification
```bash
grep -n 'first mutating verb' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Residual risks' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n '127.0.0.1' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'agent-reported' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All four print at least one line.

#### Completion Criteria
- [ ] One-shot-on-first-mutating-verb and per-attempt rotation are stated in both the CLI section and Security Invariants.
- [ ] Residual-risks paragraph names the `/proc/environ` sibling read and the read-side out-of-scope statement.
- [ ] Replan reasons travel as a file artifact and are prefixed `[agent-reported]`.
- [ ] Loopback token entropy, bind address, origin check, and valid-request rate cap are specified.
- [ ] Environment identity fields are labelled untrusted claims.
- [ ] The command-node environment name list is exhaustive and states its exclusions.

---

### Task 6: Specify prompt snapshotting

#### Objective
Remove the highest-trust component's dependency on a file any writing agent can modify.

Closes: `R1-C3`, `R2-H2`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Artifacts and Context Policy` section, the `## Graph Compilation and Validation` late-binding sentence, and the `## Settings and Graph UI` prompt-identity table.

#### Implementation
1. Apply Decision 14. Add a **"Prompt snapshots"** subsection stating: the effective prompt bytes (packaged file overlaid with the project override at `<agentsDir>/karst-graph-engineering/<name>.md`) are resolved and snapshotted into immutable content-addressed storage at **planner-run creation** and at **node-run creation**, using the same single-descriptor protocol as every other artifact (Task 7). The launch reads only the snapshot and verifies the recorded SHA-256; a mismatch blocks with `instructions-missing`.
2. Amend the existing sentence "Provider/model/effort and prompt bytes remain deliberately late-bound per agent launch": provider/model/effort stay late-bound; **prompt bytes do not** — they are bound at run creation. Edits to the on-disk prompt take effect on the next run, not on a retry of an existing one.
3. Add the reason to the section, briefly: a worker with a repository-wide write claim, or a `write`-access command node running against the canonical worktree, could otherwise rewrite the planner prompt before a replan, and the out-of-claim diff check runs only *after* the poisoned prompt was consumed.
4. Note the exception the recovery matrix needs: the recovery row "provider/model/effort/prompt configuration → retry with the latest late-bound configuration" is amended to "provider/model/effort" plus "a re-snapshotted prompt" — an explicit Resume re-snapshots, a launch retry does not.

#### Constraints
- Do not move the prompt files out of the repository; the override path stays where users expect it (Decision 15).
- Do not remove the per-invocation prompt-hash recording; it becomes the verification input.

#### Edge Cases
- The override file is deleted between snapshot and launch: irrelevant — the launch reads the snapshot. State this as the point of the change.
- The packaged prompt changes in an extension upgrade while a graph run is active: the active run keeps its snapshot; the next run picks up the new bytes.
- An override that fails to read at run creation (permissions): the run blocks with `instructions-missing` before any spend.

#### Verification
```bash
grep -n 'Prompt snapshots' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'prompt bytes remain deliberately late-bound' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- The first prints a line; the second prints **nothing** (the sentence was amended).

#### Completion Criteria
- [ ] Prompt snapshots subsection exists and covers both planner and node prompts.
- [ ] The late-binding sentence no longer claims prompt bytes are late-bound.
- [ ] The recovery-matrix row is amended.

---

### Task 7: Fix the artifact protocol, name the artifact root and workspaces, and assign teardown

#### Objective
Make artifact capture atomic, put runtime-owned bytes outside every worktree, and give them a deletion owner and a disk ceiling.

Closes: `R1-H1`, `R2-M1`, `R2-H4`, `R3-H4`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Artifacts and Context Policy` section, the `### AgentNode` workspace paragraph, the `## Budgets and Escalation` limit list, and the `## Reload, Multi-Window, and Stale Process Recovery` section.

#### Implementation
1. Apply Decision 16. Replace the current walk-then-copy description with the single-descriptor protocol, spelled out as an ordered sequence: open with `O_NOFOLLOW | O_NONBLOCK`; `fstat` the **opened descriptor**; reject non-regular files, link count > 1, size over the declared `maxBytes`, and media-type mismatch; read from that same descriptor into content-addressed storage; never re-resolve the path. State that `O_NONBLOCK` is what makes a FIFO swapped in by a live writer fail immediately instead of hanging the open.
2. State explicitly (`R2-M1`) that the **planner process is terminated and its termination proven before its submission snapshot**, exactly as node completion already requires — the two flows now have the same shape.
3. Apply Decision 15. Add a **"Runtime-owned locations"** subsection:
   - Artifact root: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/artifacts/`.
   - Node execution workspaces: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/workspaces/<nodeRunId>/<repoName>/`.
   - Both are outside every repository worktree. State the two consequences: `ship`'s plain `git add -A` cannot see them, and **no `KARST_EXCLUDE_RULES` entry is required** — record this as the reason, so a future reader does not "fix" a missing rule.
   - State that the global-storage root is shared by every window, so the path is project-scoped by construction, following the existing global-storage rule.
   - State that the `<agentsDir>/karst-graph-engineering/*.md` overrides are deliberately tracked user content inside the repository, like every existing agent prompt override, and get no exclude rule either.
4. Apply Decision 22's byte-deletion half here: the deletion owner is `deleteTicket` (hard delete removes the ticket's whole `<globalStorage>/graph/<projectSlug>/<ticketId>/` subtree) plus an activation sweep that removes subtrees whose graph run is `closed` or whose ticket no longer exists. Archive removes nothing. State that no per-ticket pruning of a live ticket's history happens in V1.
5. Apply the process-registration half of `R2-H4`: every planner and node agent session, and every command subprocess, registers with the existing `servers` registry keyed by its workspace `cwd`, so that `removeWorktree` → `stopServersUnder` and the global `reapStaleServers` sweep can both see it. State the failure this prevents by name: a ticket archived mid-graph leaving detached processes holding a tree, the 869ed2n50 class.
6. Add a workspace disk ceiling to the budget list (`R3-H4`): `maxAggregateWorkspaceBytes`, packaged default 20 GiB, hard ceiling 100 GiB, measured per graph run; exceeding it blocks with `graph-budget-exhausted` rather than starting another workspace.

#### Constraints
- Do not place the artifact root or workspaces inside any worktree; Decision 15 is binding and several other decisions depend on it.
- Do not add entries to `KARST_EXCLUDE_RULES` — with Decision 15 there is nothing inside a worktree to exclude.
- Keep the existing rule that consumers read only the snapshot whose hash was recorded.

#### Edge Cases
- Global storage is on a different filesystem than the repository: the workspace creation provider must handle a cross-device clone; state that a local clone sharing immutable object storage is acceptable only when both paths are on one filesystem, otherwise a full clone is used.
- A pre-existing workspace directory at the target path from a prior crashed run: it is removed before creation, because its owning node run is by definition superseded — state this, and that the removal goes through the same reap that checks process attribution first.
- A required output artifact whose staging destination already exists at launch: unchanged from the current text — launch is refused. Restate it inside the new protocol so it is not lost.

#### Verification
```bash
grep -n 'O_NOFOLLOW' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Runtime-owned locations' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'globalStorage' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'maxAggregateWorkspaceBytes' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'reapStaleServers' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All five print at least one line.

#### Completion Criteria
- [ ] The single-descriptor protocol is written as an ordered sequence including `O_NONBLOCK` and its FIFO rationale.
- [ ] The planner is terminated before its submission snapshot.
- [ ] Artifact root and workspace paths are named literally, outside worktrees, with the no-exclude-rule rationale.
- [ ] Byte deletion owner and sweep are assigned; archive removes nothing.
- [ ] Sessions and command subprocesses register with the `servers` registry.
- [ ] The workspace disk ceiling appears in the budget list with default and hard cap.

---

### Task 8: Specify the process-identity protocol and the ambiguity escape

#### Objective
Replace asserted "positive process resolution" with the repository's proven attribution protocol, and make every ambiguous state escapable.

Closes: `R2-H6`, `R1-H4`, `R1-H5`, `R1-C1`, `R2-M4`, `R2-M10`, `R2-H7`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Agent Transport Boundary` section, the `## Reload, Multi-Window, and Stale Process Recovery` bullets, the `## Failure Semantics` recovery matrix, and the `### approach_graph_tokens` persistence entry.

#### Implementation
1. Apply Decision 17. Add a **"Process attribution"** subsection to Agent Transport Boundary that cites `runtime/serverIdentity.ts` by name as the mandated evidence source and reproduces its hierarchy: strongest first, the live process's own cwd where the OS provides it (`/proc/<pid>/cwd`); else the live process's start time via `ps -o lstart=` matched within `START_TIME_TOLERANCE_MS`; both sides canonicalized through `runtime/pathScope.ts`'s `canonicalPath`. Outcomes are the four-way `attributable` / `dead` / `foreign` / `unknown`. State that a recorded pid is a recollection, never a handle.
2. State that `TerminationProof` requires an attributed process-**group** signal via `killTree`, with its return value checked: `killed`, `denied`, and `unknown` are three different facts, and `denied` (still running, refused) never reads as terminated. Add that a missing workspace directory is evidence of removal only when its parent directory still stands.
3. Map the outcomes to node statuses explicitly: `dead` → the node is marked stale and the graph blocks for recoverable retry; `foreign` → the recorded pid was reissued, the row is cleared and nothing is signalled; `unknown` → `termination-unknown`, leases retained, never automatically retried.
4. Apply Decision 18. Add a **"Discard unknown process"** subsection defining the one user action that escapes `launch-unknown` and `termination-unknown`, as a single transaction with these steps in order: verify the node is in one of the two ambiguous statuses; conditionally move its token `claimed → cancelled`; mark the node run `cancelled`; release its reserved graph, node-visit, and expert budget contributions; release its lease; re-evaluate the graph, blocking with `graph-topology-deadlock` if the edge is now unsatisfiable. State that this is the only path that releases a lease without proven termination, that it is user-initiated and never automatic, and that its UI copy names the risk (a process may still be running).
5. Apply `R2-M10`. Add an explicit **token transition map** to the `approach_graph_tokens` entry, enumerating every legal transition and its trigger:
   - `pending → claimed` (claim transaction)
   - `pending → cancelled` (revision drain, ticket left `impl`)
   - `claimed → consumed` (completion transaction)
   - `claimed → cancelled` (Discard unknown process; drain of a claimed activation that cannot finish)
   - No other transition is legal. State specifically that a launch retry after a proven-no-process failure keeps the token `claimed` and reuses the reserved visit, incrementing only the launch-attempt counter — the token never returns to `pending`.
6. Apply `R2-H7`. Add two reload bullets covering the statuses the current list omits:
   - A node found in `completing` or `integrating` with a **demonstrably dead** process: resume the completion pipeline from where it stopped — terminate-verify, snapshot, integrate, then consume the already-reported outcome. Do not re-execute the node; the outcome is already in hand and re-running duplicates both spend and integration.
   - A node found in `completing` or `integrating` with a **live attributable** process: revert the status to `running` and let completion proceed normally.
7. Apply Decision 22's budget half here as a cross-reference: cancelled reservations release their budget contributions, so a drained revision does not permanently consume revision N+1's ceilings.

#### Constraints
- Do not invent a new probe; `serverIdentity.ts`'s hierarchy is the mandated one.
- Do not make any ambiguity escape automatic — every escape from `launch-unknown`/`termination-unknown` is user-initiated.
- Do not add a `claimed → pending` transition.

#### Edge Cases
- The workspace directory is gone *and* its parent is gone (an unmounted volume): this is `unknown`, not `dead` — the design must say so, matching the existing `directoryGone` rule.
- Two windows both offer "Discard unknown process" for the same node: the transaction is conditional on the current status, so exactly one succeeds and the other is an idempotent no-op.
- A discarded node whose successor edge was the only path to `END`: the re-evaluation blocks with `graph-topology-deadlock`, which is a recoverable blocker leading to replan — state this so the user is not left with a silently dead graph.

#### Verification
```bash
grep -n 'serverIdentity' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Discard unknown process' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'claimed → cancelled' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'completing' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md | wc -l
```

Expected:
- The first three print at least one line each.
- The fourth prints a count of at least `4` (the status union, the two guards, and the two new reload bullets).

#### Completion Criteria
- [ ] Process attribution cites `serverIdentity.ts` and reproduces the full evidence hierarchy and four outcomes.
- [ ] `TerminationProof` requires a process-group signal with a checked return.
- [ ] "Discard unknown process" is specified as one ordered transaction.
- [ ] The token transition map enumerates exactly four legal transitions and forbids `claimed → pending`.
- [ ] Both `completing`/`integrating` reload rules exist.

---

### Task 9: Specify the session and launch entry-point matrix

#### Objective
Prevent a stray ticket-level launch from placing a second, unclaimed agent inside a running graph, and keep terminal re-identification working.

Closes: `R1-H10`, `R2-H5`, `R2-L11`, `R2-L12`, `R2-L10`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Scheduler Runtime` session paragraph and the `## Agent Transport Boundary` section.

#### Implementation
1. Apply Decision 19. Replace "The current ticket-level session assumptions must be generalized across `SessionManager`, …" with the resolved rule: graph planner and node sessions are owned by `AgentTransport` and **bypass `SessionManager` entirely**. `SessionManager` (`ui/session.ts:255-256`, a `Map<number, TrackedSession>`) stays 1:1 and legacy-only; no key change is made to it. Graph sessions are keyed `(ticketId, nodeRunId)` inside the transport's own registry.
2. Add an **entry-point matrix** table with one row per existing ticket-level launch path and its behavior while a graph run is active in `planning`, `running`, or `draining`:

   | Entry point | Behavior while a graph run is active |
   |---|---|
   | `openSession` (dashboard Open) | Focuses the planner or a node terminal chosen in the Inside view; never spawns |
   | `nudge` | No-op; the coordinator owns continuation |
   | `adoptRevivedSession` | Adopts only terminals whose `KARST_LAUNCH_ID` matches a live node/planner run; never launches |
   | `driveTicket` | Not invoked for a graph ticket at `impl`; the coordinator drives instead |
   | `resumeFixSession` | Unreachable at `impl`; belongs to the `fix` stage |

   State that each row is a testable assertion, not guidance.
3. Apply Decision 20 to the environment contract: `KARST_TICKET_ID` keeps its meaning; `KARST_LAUNCH_ID` carries the **node-run id** (or planner-run id) for graph sessions so `ui/terminalIdentity.ts` re-identifies revived terminals unchanged; graph-specific values use new `KARST_GRAPH_*` names. List the full set in the Completion CLI section beside the existing bullet list.
4. Apply `R2-L12`. State that the graph Stop signal is owned by a **coordinator-level controller**, not the stage driver's `DriverController` — a graph ticket at `impl` is never driven by `driveTicket`, so the existing per-run `AbortController` has no routing to it. Specify that dashboard Stop reaches running node processes through `AgentTransport.terminate` for every node run of the active graph, and that Stop moves the graph run to `draining`, never to `blocked`.
5. Apply `R2-L10`. State that graph scheduling never reads hook delivery: hooks are diagnostics only, they post to a per-window port that dies with its window, and a surviving node's hooks going nowhere is expected and logged as one bounded diagnostic, not an error.

#### Constraints
- Do not change `SessionManager`'s key type; Decision 19 is binding.
- Do not route completion through hooks under any circumstance.

#### Edge Cases
- A user manually opens a terminal in a node workspace: it carries no `KARST_LAUNCH_ID`, so it is never adopted and never counted — state this.
- A graph run in `completed-awaiting-impl-marker` (no active work): `openSession` behaves normally again, which is what makes the Inside "Complete implementation" action usable beside a refreshed session.
- Window reload with live node processes: terminal re-identification uses the pid record exactly as it does today; the `KARST_LAUNCH_ID` mapping is what keeps that path unchanged.

#### Verification
```bash
grep -n 'bypass `SessionManager`' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'KARST_LAUNCH_ID' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'resumeFixSession' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All three print at least one line; the third appears inside the entry-point matrix.

#### Completion Criteria
- [ ] Graph sessions bypass `SessionManager`; the legacy map is unchanged.
- [ ] The entry-point matrix has all five rows with concrete behaviors.
- [ ] The env-key mapping is stated, including `KARST_LAUNCH_ID` = node-run id.
- [ ] Graph Stop ownership and routing are specified.
- [ ] Hooks are stated diagnostics-only.

---

### Task 10: Pin the remaining transaction shapes and establish liveness

#### Objective
Close the four unpinned transaction shapes and guarantee a committed completion is never stranded.

Closes: `R2-M5`, `R2-M6`, `R2-M8`, `R1-M6`, `R2-H8`, `R1-L4`, `R2-M15`, `R2-M3` (drain-conflict half).

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Scheduler Runtime` numbered loop, the `## Edge and Activation Model` claiming paragraph, the `## Parallel Scheduling and Resource Claims` section, and the `## Persistence` transaction paragraph.

#### Implementation
1. Apply `R2-M5`. Rewrite scheduler step 11: the quiescence check and the graph-run status flip are **one `BEGIN IMMEDIATE` transaction** that re-reads every condition the END-quiescence rule names. State that a read-then-write here lets a concurrent window's completion commit successor tokens in between, after which the marker guard correctly refuses and no reopen path exists — the ticket would be stuck.
2. Apply `R2-M6`. Generalize the claiming rule from "exactly one row changed" to "exactly the expected number of rows changed — 1 for a single activation, `|waitFor|` for a join firing". Specify join firing as one all-or-nothing transaction that conditionally claims all correlated arrivals, creates the join visit, and inserts the successor token, aborting with no partial claim if any arrival is not claimable.
3. Apply Decision 21 for contention. Add a **"Lock liveness"** paragraph: WAL is already enabled (`store/db.ts:22`) — state it as an existing fact, not a new requirement. A contended `BEGIN IMMEDIATE` in the extension host **aborts immediately** rather than waiting on a busy timeout, because a synchronous wait blocks the shared event loop; the aborted claim counts nothing, mutates nothing, and is retried on the next reconciliation tick within the ≤100-transition cap. Separately, the CLI's `writableStore` shim currently issues plain `BEGIN` with no busy timeout (`src/cli/writableStore.ts:40-42`); for graph verbs it is upgraded to `BEGIN IMMEDIATE` plus a bounded busy timeout, so a concurrent completion surfaces as a retry rather than an unhandled `SQLITE_BUSY`.
4. Apply `R2-H8`. Add a **"Coordinator sweep"** paragraph: a bounded periodic reconciliation rides the existing background PR sweep in `extension.ts` — the same precedent that lets `settleShipGates` observe a merge no window performed. State the invariant plainly: a completion that committed to the database is always eventually scheduled, even when its wake-up hit a dead port, because the sweep re-reads canonical state and never depends on the callback.
5. Apply `R2-M15`. State that integration is serialized by a **durable database-backed lease** — an `approach_resource_leases` row with status `held`, acquired in the claim transaction — never an in-memory mutex, because two windows may legitimately complete different nodes concurrently.
6. Apply `R2-M3`. Add to the replan protocol: revision N+1's compilation validates its resource claims against the set of still-`held` leases from the draining revision N, and a node whose claims conflict is scheduled only after those leases release. State that this is a scheduling deferral, not a compile error.
7. Apply `R1-L4`. Add one sentence acknowledging that multi-window reconciliation produces a **consistent but not globally reproducible** execution order: two tokens created in different windows within the same millisecond order by token id, which reflects commit sequence rather than logical cause.

#### Constraints
- Do not introduce a synchronous busy-wait anywhere in the extension host.
- Do not weaken the existing rule that correctness never depends on an in-memory single-flight or one open window.
- Keep the ≤100-transitions-per-tick cap.

#### Edge Cases
- A join whose arrivals are split across two windows' completion transactions: the join firing transaction sees only committed tokens, so it either claims all `|waitFor|` or none and retries next tick.
- The sweep firing while a claim transaction from the same window is open: the tick's transitions are bounded and each claim is independently conditional, so a partial tick is always a legal state.
- A drain whose leases never release because the holder is `termination-unknown`: resolved only by Task 8's Discard action; state the cross-reference so the deadlock has a named exit.

#### Verification
```bash
grep -n 'BEGIN IMMEDIATE' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md | wc -l
grep -n 'Coordinator sweep' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'exactly the expected number of rows' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Lock liveness' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- The first prints at least `3`.
- The other three print at least one line each.

#### Completion Criteria
- [ ] Step 11 is one `BEGIN IMMEDIATE` transaction with the stated rationale.
- [ ] The N-ary join claim rule and all-or-nothing firing are specified.
- [ ] Lock liveness covers both the host abort-on-busy policy and the CLI shim upgrade, citing `writableStore.ts:40-42`.
- [ ] The periodic coordinator sweep is mandated with its never-stranded invariant.
- [ ] Integration serialization is a durable lease.
- [ ] Replan-vs-draining-lease conflicts defer rather than fail.
- [ ] Non-reproducible multi-window ordering is acknowledged.

---

### Task 11: Complete the persistence contract

#### Objective
Turn the eight table sketches into a contract an implementer can write DDL from without inventing semantics.

Closes: `R2-H9`, `R2-H10`, `R2-M9`, `R2-M10` (table half), `R2-M11`, `R2-M12`, `R2-M13`, `R2-M14`, `R2-L5`, `R2-L6`, `R2-L8`, `R2-L15`, `R1-M7`, `R1-M8`, `R1-M11`, `R1-M12`, `R1-M13`, `R1-M9`, `R2-L7` (statement half), `R1-I4`, `R2-I1`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the whole `## Persistence` section.

#### Implementation
1. Apply Decision 22's PK half: state once, above the table list, that **every** table uses `INTEGER PRIMARY KEY` (rowid alias) and that `AUTOINCREMENT` is deliberately absent because all eight tables are append-only, so rowid reuse cannot occur.
2. Apply Decision 22's FK half. Add a **"Delete policy"** subsection with one row per table naming its `ticket_id`/parent reference and its `ON DELETE` behavior. Bind it to the repository's existing contract: `TICKET_CHILD_TABLES` (`store/tickets.ts:471-479`) and `deleteTicket`'s explicit leaf-first ordering (`tickets.ts:496-533`) with the ledger detached first. State: `approach_graph_runs.ticket_id REFERENCES tickets(id)` with **no cascade**; the eight tables are added to the explicit deletion sequence after `process_runs` and before the older child tables; archive is a soft delete and removes nothing; hard delete also removes the ticket's byte subtree (Task 7).
3. Apply Decision 23. Delete `active revision id` from `approach_graph_runs` and state that the active revision is **derived** by reading `approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'`, following the read-filtered derivation precedent in `store/mergeChecks.ts`; keep the partial unique index that permits at most one active revision per run.
4. Apply `R2-M9`. Add `cancelled` to the `approach_graph_runs` status union and define its entry transaction: a ticket that leaves `impl` cancels every pending token and moves the run to `cancelled` without rewriting completed evidence. Add `awaiting-confirmation` to a stated transition map.
5. Apply `R2-L5`. Add **transition maps** for all five stateful tables — graph run, revision, node run, token (from Task 8), lease — as explicit tables of `from → to (trigger)`. State that closed-value `CHECK`s enforce membership only; transition legality is application code, and these maps are the testable contract.
6. Apply `R2-M13`. Give `approach_resource_leases` an `id INTEGER PRIMARY KEY` plus `UNIQUE(owner_node_run_id, physical_domain)`, and enumerate `held → released` and `held → ambiguous-process` and `ambiguous-process → released` (only via Task 8's Discard action).
7. Apply `R2-L8`. Specify the entry-token representation as `source_node_run_id INTEGER NULL` plus `is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1))`, because a closed-value `CHECK` over a nullable FK cannot express "a real reference or the sentinel".
8. Apply `R1-M5`, `R1-M13`, and `R1-M7` together in a **"Lineage"** subsection: `fork_instance_id` is a host-generated UUIDv7 string minted at each fork execution; every descendant token carries a bounded fork-lineage **stack** of those ids, outermost first, with a maximum depth equal to the compiler's nesting bound. Join correlation matches on the full lineage stack **and** the fork's visit number, so two arrivals from the same predecessor at different loop iterations never correlate. Artifact instances record the producing run's lineage stack, and input resolution walks the activation's own lineage — an instance from a superseded revision is never in a new revision's lineage, which is what prevents cross-revision binding.
9. Apply `R2-H9` and `R1-M10`. Replace "atomic under a cross-window migration lock" with the mechanism: `BEGIN IMMEDIATE` opened before reading `user_version`; every guarded DDL step plus the `user_version` bump inside it; `COMMIT`. State the current fact that makes this a change: `migrate()` (`store/migrations.ts:90-1086`) today has no outer transaction and each step autocommits, with idempotency coming only from column guards. State that every statement stays guard-based so a mid-crash re-run is safe, and that the busy behavior relies on the connection's busy timeout at open.
10. Apply `R2-M12`. State the dual-source convention explicitly: byte-identical DDL in `src/store/schema.sql` and in a new guarded step in `src/store/migrations.ts`; `SCHEMA_VERSION` bumped from its current `33`; and `db.test.ts`'s hardcoded `user_version` and table-count assertions updated.
11. Apply `R2-L15` and `R1-M11`. State that the **stored canonical bytes are authoritative** on reload and the SHA-256 fingerprint is verified on read, with a mismatch blocking rather than silently recompiling. Add that the canonicalization implementation is pinned by a reference-graph test whose expected output must not change across dependency upgrades.
12. Apply `R2-M14`. Add a **"Retention"** statement: graph evidence survives archive, dies with `deleteTicket`, and is not pruned per-ticket in V1; the per-ticket upper bounds (≤1000 tokens, ≤200 node runs, ≤6 revisions, and the artifact/workspace ceilings) are what make unbounded growth impossible.
13. Apply `R1-M9`, `R2-L7`, `R1-I4`, `R2-I1` as three short statements: graph tickets write **no** `phase_marks` rows, because the only writer is `recordPhaseMark` (`store/phaseMarks.ts:80`) reachable only from `karst phase`, which graph seeds never contain; the stored canonical graph JSON is the validated, default-expanded document bounded by the compilation limits; and all new CLI store paths use bound positional parameters per the CLI's driver-agnostic convention, pinned by a test.

#### Constraints
- Do not add `ON DELETE CASCADE` to any new table's ticket reference.
- Do not keep `active_revision_id`.
- Do not change `SCHEMA_VERSION`'s current value in this document beyond stating that it is bumped from 33.

#### Edge Cases
- A graph run whose ticket is hard-deleted mid-execution: `deleteTicket` runs the explicit sequence, and the byte subtree removal happens after the rows; live processes are handled by the Task 7 registry registration, not by the delete itself.
- A revision left `active` when its graph run is `cancelled`: the transition map must route it to `superseded`; state this so no orphan `active` row survives a cancelled run.
- A migration interrupted mid-transaction: SQLite rolls it back and `user_version` is unchanged, so the next open re-runs the same guarded steps. State this as the recovery story.

#### Verification
```bash
grep -n 'INTEGER PRIMARY KEY' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Delete policy' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'active revision id' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'UUIDv7' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'schema.sql' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'phase_marks' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All print at least one line **except** `active revision id`, which must print nothing.

#### Completion Criteria
- [ ] PK rule stated once and applied to all eight tables.
- [ ] Delete policy table exists and binds to `TICKET_CHILD_TABLES` and `deleteTicket` ordering.
- [ ] `active_revision_id` removed; derivation specified.
- [ ] `cancelled` added to the run status union with its transaction.
- [ ] Five transition maps present.
- [ ] Lease PK + uniqueness + transitions specified.
- [ ] Entry-token two-column representation specified.
- [ ] Lineage subsection covers generation, stack, join correlation with visit number, and cross-revision isolation.
- [ ] Migration mechanism replaces the unmechanised claim and cites the current `migrate()` fact.
- [ ] Dual-source convention, `SCHEMA_VERSION` bump from 33, and `db.test.ts` assertions named.
- [ ] Canonical bytes authoritative; fingerprint verified; pinning test named.
- [ ] Retention statement present.
- [ ] `phase_marks`, canonical-JSON bound, and bound-parameter statements present.

---

### Task 12: Resolve token-usage attribution for graph runs

#### Objective
Give graph spend exactly one accounting seam that the current schema can carry.

Closes: `R2-H3`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the token-usage paragraph in `## Budgets and Escalation` and the `## Persistence` migration list.

#### Implementation
1. Apply Decision 25. Replace the `instrumentedAgentTransport` paragraph with the resolved design:
   - Every graph launch — planner and node — opens a `process_runs` row, which the **existing** interactive usage sampler binds to. This keeps one interactive accounting seam, satisfying the measured-once invariant, rather than adding a second.
   - State the fact that forces this: `interactive_usage_samples.process_run_id` is `NOT NULL REFERENCES process_runs(id)` (`schema.sql:707`), so an interactive graph session with no `process_runs` row is unrecordable.
   - `token_usage` gains two nullable columns in the same migration — `approach_planner_run_id` and `approach_node_run_id`, both `ON DELETE SET NULL` — following the existing detachment pattern used by `implementation_segment_id` and `interactive_usage_sample_id` (`schema.sql:657-662`), so deleting graph history never takes the ledger's spend with it.
   - `AI_CALL_SITES` (`agent/aiCallSites.ts:18-46`) gains exactly two members: `graph-planner` and `graph-node`. State that node identity travels in the new FK columns, not in the call site, because the call-site set is closed and must stay bounded.
2. Keep and restate the existing rules: a transport that cannot report usage records `unknown`, never a fabricated zero; no prompt or completion text is stored; the store write is wrapped and swallowed so a locked database never fails a launch.
3. Add the profile attribution: the resolved profile name is recorded on the node/planner run, not on `token_usage`, and usage rolls up to profile by joining through the run — no new column is needed for it.

#### Constraints
- Do not introduce a second interactive accounting seam.
- Do not add node-run identity to `AI_CALL_SITES`.
- Do not remove the `unknown`-not-zero rule.

#### Edge Cases
- A headless call made inside a graph (none in V1, but the schema permits it): recorded through the existing `instrumentedAdapter` seam with the graph FK columns set.
- A node run deleted while its usage rows remain: `ON DELETE SET NULL` keeps the spend and drops the attribution, matching the ledger contract.
- A provider reporting a cumulative tally: unchanged — the existing reader takes it as-is rather than summing.

#### Verification
```bash
grep -n 'process_runs' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'approach_node_run_id' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'graph-planner' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All three print at least one line.

#### Completion Criteria
- [ ] Graph launches open `process_runs` rows; the `NOT NULL` fact is cited.
- [ ] Two nullable `ON DELETE SET NULL` columns on `token_usage` are specified.
- [ ] Exactly two new call sites are named.
- [ ] Profile attribution is via join, not a new column.

---

### Task 13: Specify catalog effort metadata

#### Objective
Give the effort feature the metadata home its shipped defaults depend on.

Closes: `R2-H12`, `R2-I3`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `### Execution policy resolution` effort paragraphs and adapter table.

#### Implementation
1. Apply Decision 26. Add a **"Catalog effort metadata"** paragraph stating the additive change: `ModelOption` (`agent/modelCatalog.ts:3-10`, today exactly `{id, label, providers}`) gains one optional field `efforts?: readonly string[]`. The same field is mirrored into the published `model-catalog.json` at the repository root, and the existing `modelCatalog.test.ts` "matches the published model feed exactly" test pins the two copies — so adding a model or an effort value means editing both files, as it does today.
2. State the resolution rule: a model with no `efforts` array accepts **no** effort value; an explicitly configured effort that the selected model does not advertise is a configuration failure at Save, never silently discarded.
3. Amend the OpenCode row of the adapter table with Decision 26's rule: effort **is** the model variant, so an OpenCode profile setting both `model` and `effort` is rejected at Save. Note the current fact that the bundled OpenCode catalog is deliberately empty and the feed tier is opt-in with no default URL, so OpenCode effort is unresolvable on a default install — a project pointing a profile at OpenCode must configure a feed first.
4. Amend the packaged-defaults paragraph: with Decision 10 the packaged planner effort is `high`; state that `claude-opus-5` and `claude-sonnet-5` are both present in `BUNDLED_CATALOG` so the model ids resolve today, and that the residual work is the `efforts` metadata plus adapter capability tests, both required in Slice 1 before the VSIX ships.

#### Constraints
- Do not add a required field to `ModelOption`; `efforts` is optional so every existing entry stays valid.
- Do not introduce a graph-local model list; the shared catalog is the only source.

#### Edge Cases
- A custom model id typed by the user that is not in the catalog: it has no `efforts`, so it accepts no effort — state that this is the intended conservative behavior, not a bug.
- A feed that supplies `efforts` for a model the bundled catalog lacks: the feed tier wins per the existing precedence, and the effort validates against the feed entry.
- An adapter whose CLI exposes no effort flag: the field is not rendered at all, per the existing "unsupported cores expose no effort field" rule — restate it beside the new metadata.

#### Verification
```bash
grep -n 'efforts?' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'modelCatalog.test.ts' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'model-catalog.json' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All three print at least one line.

#### Completion Criteria
- [ ] `efforts?: readonly string[]` is specified as an additive optional field with both copies and the pinning test named.
- [ ] No-`efforts`-means-no-effort rule is stated.
- [ ] OpenCode variant conflict rule and empty-bundled-catalog fact are in the adapter table.
- [ ] Packaged default effort is `high`, with the Slice 1 obligation named.

---

### Task 14: Enumerate the failure-semantics and Resume ripple

#### Objective
Make the new blocker kind's effect on every closed switch explicit, and remove the unreachable marker path.

Closes: `R2-M19`, `R2-M18`, `R2-M20`, `R2-L9`, `R1-I2`, `R1-I3`, `R2-L13`, `R2-L14`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Failure Semantics` section, the `## Scheduler Runtime` marker paragraph, the `## Module and Dependency Boundaries` section, and the `## Settings and Graph UI` section.

#### Implementation
1. Apply `R2-M19`. Add a **"BlockerKind ripple"** table listing every consumer of the closed union that gains a case for `approach-graph-failed`, with what each renders. Base it on the current union (`model/types.ts:59-71`) and its consumers:

   | Consumer | Behavior for `approach-graph-failed` |
   |---|---|
   | `needsUser` (`model/ticketGlyph.ts`) | Amber — the graph needs a human decision |
   | dashboard `renderBlocked` | Title "Implementation graph blocked"; renders a **graph recovery** button, not the generic Resume |
   | `resumeBlockedStage` (`workflow/stageResume.ts`) | Refuses to clear it; returns the typed graph recovery action instead of `true` |
   | Inside ship/stage strips | Lists every blocking planner/node run, not only the projected earliest |

2. State the `resumeBlockedStage` signature change concretely: its return type widens from `boolean` to a discriminated result — `{kind:'cleared'} | {kind:'refused'} | {kind:'graph-recovery', ticketId, graphRunId}` — and every caller updates. Cite the current implementation, which returns `boolean` and clears any block whose kind is not `awaiting-merge`, as the reason this is a mandatory compatibility change.
3. Apply `R2-M18`. Replace "the sole graph/stage integration point" with the accurate list of **three** integration surfaces: the guarded IMPL marker service, the `approach-graph-failed` stage block write and clear, and the typed graph recovery action returned by `stageResume`. State that all three live in the same thin `src/workflow/graphMarkerGuard.ts`-owned boundary module so the count stays at three.
4. Apply `R2-M20`. Delete the phrase "a user may also invoke the normal marker from a separately refreshed trusted IMPL session" — it is unreachable, because graph seeds never contain `cliStagePrefix`. State that the Inside **"Complete implementation"** action is the only marker entry point for a graph ticket.
5. Apply `R2-L9`. State that completion writes are **window-agnostic by design** — there is no window field in the conditional UPDATE and there must not be, because after a reload the old window's agent is still the legitimate owner. "Wrong-window" applies solely to loopback routing identity.
6. Apply `R1-I2` and `R1-I3` as two sentences: the marker guard runs after graph quiescence and is authored by the host, not by the graph runtime — it is not a graph event; and stage block writes for `approach-graph-failed` go through the existing stage-block infrastructure (`store/stageBlocks.ts`), never a direct `UPDATE stages`.
7. Apply `R2-L13` and `R2-L14` in the UI section: mark structured diagnostics and per-invocation interactive usage reporting as **Slice 6** where they appear, so no reader expects them at V1; and add a short subsection naming the Inside controls for a graph ticket (what replaces Launch / Open session / reveal terminal) and the board glyph for graph-running and graph-blocked tickets.

#### Constraints
- Do not add a second new `BlockerKind`; one is enough.
- Do not route the block write outside the existing stage-block infrastructure.

#### Edge Cases
- A graph ticket that is also `awaiting-merge`: impossible — `awaiting-merge` belongs to `ship`, the graph to `impl`. State it so no consumer writes defensive code for it.
- A stage block written while the ticket has already left `impl`: refused by the existing stage-scoped write path; state the cross-reference.
- Multiple simultaneously blocking node runs: the stage block projects the earliest by durable event order while Inside lists all — this rule already exists; keep it and reference it from the ripple table.

#### Verification
```bash
grep -n 'BlockerKind ripple' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'separately refreshed' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'window-agnostic' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Slice 6' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All print at least one line **except** `separately refreshed`, which must print nothing.

#### Completion Criteria
- [ ] Ripple table has all four consumers with concrete behavior.
- [ ] `resumeBlockedStage`'s new return type is written out.
- [ ] Three integration surfaces are named; "sole" is gone.
- [ ] The unreachable marker path is deleted; Inside action is the only entry.
- [ ] Window-agnostic completion writes are stated.
- [ ] Guard-is-not-a-graph-event and stage-block-infrastructure sentences present.
- [ ] Slice 6 markers and the Inside/glyph subsection exist.

---

### Task 15: Fix the compiler boundary, structural bounds, and add the planner repair loop

#### Objective
Keep the compiler pure, make structurally-decidable deadlocks compile errors, and stop a schema-invalid first draft from becoming a red block.

Closes: `R2-M17`, `R2-L4`, `R1-L1`, `R3-H2`, `R2-H15`, `R3-L2`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Graph Compilation and Validation` section, the `## Module and Dependency Boundaries` diagram, the `### GateNode` section, and the `## Edge and Activation Model` outcome paragraph.

#### Implementation
1. Apply Decision 29 (`R2-M17`). State that physical resource domains — canonical worktree realpath plus Git common-directory identity — are resolved by the **store/scheduler layer** and passed into compilation as an injected resolved map, because they are registry and filesystem facts, not a pure function of the graph document. The compiler stays pure and imports no stores; remove the sentence implying compilation derives them itself.
2. Apply `R2-L4`. Add a compile check: bound the number of executions of each fork source per revision and require every join's `maxVisits` to be at least that bound; a join budgeted below its fork's multiplicity strands the later instances in `graph-topology-deadlock`, and that condition is statically computable. Reject at compile rather than deadlocking at runtime.
3. Apply `R1-L1`. Add a compile-time warning — not an error — when the ratio of pairwise-overlapping write claims to total agent nodes exceeds a stated threshold, surfaced as a compile diagnostic so a planner that serializes everything is visible rather than silently slow.
4. Apply Decision 28 (`R3-H2`). Add a **"Compile repair loop"** subsection: a rejected graph document returns to the **same** `PlannerRun` with the compiler's structured diagnostics as input, up to **3 compile attempts total** for that run, before the run fails to `graph-plan-invalid`. Attempts increment a `compile_attempt` counter on the planner run and do **not** create new planner runs, so they cost no planner-run or expert-run budget. State the reason plainly: the compiler is strict — dominance, post-dominance, SCC visit bounds, unknown-field rejection, causal artifact binding, safe-integer ranges — and a first-pass rejection is the expected case, not an exceptional one. Add `compile_attempt` to the `approach_planner_runs` column list in the Persistence section.
5. Apply Decision 27 (`R2-H15`). Add an explicit paragraph to the Edge and Activation Model: agent `blocked` and `replan` are the **one deliberate exception** to karst's never-route-on-agent-self-report rule; they are budget-bounded and cannot advance a stage. Add the precondition: a `replan` is honored only when the activation's causal lineage contains at least one failed deterministic command/gate outcome, a `resource-claim-violated`, or an `integration-conflict`; a `replan` with no such evidence is recorded as evidence and treated as `blocked`.
6. Apply `R3-L2`. Add one sentence to GateNode stating the V1 limitation: predicates see visit counts, outcome counts, expert-run counts, and artifact existence only — not exit codes, not which repository failed, and not artifact content. State it so the planner prompt is not authored against a capability that does not exist.

#### Constraints
- Do not let the compiler import stores; Decision 29 is binding and the dependency diagram must stay one-way.
- Do not make the overlap-ratio check an error.
- Do not raise the compile-repair attempt count above 3 or charge attempts to the planner-run budget.

#### Edge Cases
- A planner that returns byte-identical invalid output on every attempt: the loop still terminates at 3 and fails to `graph-plan-invalid`; state that no progress check is attempted.
- A repair attempt that produces a *different* invalid document: identical handling; the diagnostics for the newest failure are the ones carried into the next attempt.
- A `replan` reported by a node whose lineage contains only its own prior `blocked`: no qualifying evidence, so it is treated as `blocked` — state this specific case, since it is the obvious injection path.

#### Verification
```bash
grep -n 'Compile repair loop' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'compile_attempt' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'injected resolved map' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'one deliberate exception' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All four print at least one line, and `compile_attempt` appears in both the repair-loop subsection and the `approach_planner_runs` column list.

#### Completion Criteria
- [ ] Physical-domain derivation is injected; the compiler-purity arrow is intact.
- [ ] Fork-multiplicity vs join `maxVisits` is a compile check.
- [ ] Overlap-ratio warning specified as a diagnostic, not an error.
- [ ] Repair loop: 3 attempts, same planner run, diagnostics fed back, `compile_attempt` column added.
- [ ] Self-report exception and `replan` evidence precondition are stated.
- [ ] Gate predicate limitation is stated.

---

### Task 16: Add the Premise and Measurement section

#### Objective
Record the design's relationship to karst's existing merge doctrine, the cost question, the success criteria, and the platform scope — the four premise-level items that no implementation detail can settle.

Closes: `R3-H1`, `R3-H3`, `R3-M1`, `R3-M3`, `R3-L1`, `R1-I5`, `R1-I6`, `R1-I8`, `R2-I4`, `R2-I2`.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — a new `## Premise and Measurement` section placed immediately before `## Architectural Rationale`, plus small edits to `## Settings and Graph UI` and `## Delivery Strategy`.

#### Implementation
1. **Integration doctrine** (`R3-H1`). State the distinction explicitly: karst retired the `merge` stage because a landing is not work karst performs — that rule is about the **PR boundary**, where a remote, a teammate, and a review sit between karst and the result. Intra-ticket integration is different in kind: karst owns both sides, there is no remote, and the conflict being resolved is one karst created by fanning the work out. Therefore the graph runtime integrates node change sets into the ticket's canonical worktrees, and `integration-conflict` is a graph blocker, while the PR-landing rule is untouched. State that this distinction is load-bearing and must not be re-litigated during implementation.
2. **Cost model** (`R3-H3`). State the obligation: before Slice 3 commits to the executor design, a worked cost comparison on one representative ticket — single-agent `impl` versus the generated graph — is produced and recorded in this document. State why the question is open: every node launches a fresh session with no `--resume`, so cached-prefix reuse is deliberately given up, and artifacts bound transcript growth but not re-sent context. State the decision rule: if the graph costs materially more for an equal outcome, budgets expressed as run counts and wall time are the wrong control surface and the budget primitives are revisited before Slice 3 ships.
3. **Success and abandonment criteria** (`R3-M1`). State the measurement, to be baselined in Slice 1 and evaluated after Slice 3: on N real tickets, compare graph versus non-graph on implementation wall time, total token cost, count of human interventions, and UAT-pass-on-first-attempt rate. State the abandonment criterion in one sentence: if the graph does not improve at least one of those four without worsening the others, the approach ships disabled and the slices after it are not built.
4. **Platform scope** (`R3-M3`). State that the Windows path rules — alternate data streams, reserved device names, drive/UNC escapes, trailing dots and spaces, Unicode-normalization aliases — are enforced by **pure-string unit tests over the normalizer**, and that no Windows runtime support is asserted for the graph runtime in V1. Record the fact that makes this necessary: the native addon ships a `darwin-arm64` prebuild and no Windows runtime is under test.
5. **Node base prompt** (`R3-L1`). Resolve the dangling `karst-graph-node` identity by specifying its consumer: the node base prompt is prepended to every agent node's assembled context, ahead of the node's `instructionsArtifact`, and its snapshot hash is part of the frozen per-launch prompt hash (Task 6). Add it to the Artifacts and Context Policy assembly list, which currently omits it.
6. **`confirmGeneratedGraph` justification** (`R1-I5`). With Decision 10 defaulting it to `true`, state the scenario Stop cannot cover: Stop interrupts work already underway and already paid for, while confirmation is the only point at which a user can read the generated topology before any token is spent on executing it.
7. **Delivery-strategy details** (`R1-I6`, `R1-I8`, `R2-I4`): for each slice, state which prior slice's API it depends on and which API it extends; and name the per-slice plan output location as `docs/plans/` following this repository's existing convention, with one parent roadmap plus one plan per slice.
8. **ACP boundary** (`R2-I2`). Add one sentence: an ACP `session-ended` event maps to **termination evidence only**, never to an outcome, and ACP endpoints must be loopback-bound with no remote callback addresses.

#### Constraints
- Do not soften the merge-doctrine statement into an open question; Decision 30 requires a resolved position.
- Do not defer the cost model to "later" without naming Slice 3 as the gate.
- Do not claim Windows runtime support.

#### Edge Cases
- The cost comparison is not produced by the time Slice 3 starts: state that this blocks Slice 3, and that the block is deliberate.
- A measurement that is favorable on cost but unfavorable on intervention count: covered by the stated rule — improvement in at least one dimension without regression in the others.

#### Verification
```bash
grep -n 'Premise and Measurement' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'abandonment' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'karst-graph-node' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'darwin-arm64' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
```

Expected:
- All four print at least one line; `karst-graph-node` now appears in the context-assembly list as well as the prompt-identity table.

#### Completion Criteria
- [ ] Merge-doctrine distinction is stated as a resolved position.
- [ ] Cost-model obligation names Slice 3 as the gate and states the decision rule.
- [ ] Four success metrics and the abandonment criterion are stated.
- [ ] Windows scope is pure-string tests only, with the prebuild fact recorded.
- [ ] The node base prompt has a named consumer in the assembly list.
- [ ] `confirmGeneratedGraph`'s justification is stated.
- [ ] Per-slice API dependencies and plan output location are named.
- [ ] ACP `session-ended` maps to termination evidence only.

---

### Task 17: Re-sequence the delivery slices and update the verification strategy

#### Objective
Make the slice plan consistent with every decision above, and make the verification list cover the new behaviors.

Closes: `R2-H14`, `R3-M2` (slice half), `R2-L13` (slice half), plus verification coverage for Tasks 2–16.

#### Files
- `docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md` — the `## Delivery Strategy` and `## Verification Strategy` sections.

#### Implementation
1. Apply Decision 31. Amend Slice 1: the built-in approach ships **disabled by default** (`enabled: false`), invisible to the picker, the analyzer, and launch resolution. Amend Slice 3 to state that it is the slice that flips the default to enabled, once planner submission, executors, and the guarded marker exist. State the failure this prevents: a ticket picking the approach in Slices 1–2 would get an impl launch with no graph runtime behind it.
2. Add to Slice 1's contents: the manifest pipeline obligations (Task 2), the built-in overlay seam (Task 3), the catalog `efforts` metadata plus adapter capability tests (Task 13), and the Slice-1 half of the measurement baseline (Task 16, item 3).
3. Add to Slice 5's contents: raising the packaged `maxParallel` default from 1 to 4.
4. Add to Slice 3's entry conditions: the cost comparison from Task 16, item 2.
5. Extend the Verification Strategy lists with one bullet per new behavior introduced by Tasks 2–16. At minimum, add:
   - manifest round-trip of a full graph config block through load → save → load;
   - a labelless tombstone is refused; merge is by `id`, not position;
   - the built-in resolves through `withBuiltInApproaches` in all three consumers and counts as installed;
   - `pickerTouched` gating; `defaultApproach` behavior unchanged;
   - the expert-budget compile formula rejects an over-budget expert node;
   - per-repository command subprocesses run serially and consume one slot;
   - capability consumed by the first mutating verb and rotated per attempt;
   - replan reasons arrive as an artifact, never argv;
   - a prompt modified on disk mid-run does not affect the active run;
   - the single-descriptor artifact read rejects a symlink, a FIFO, a hardlinked file, and a mid-flight swap;
   - artifact root and workspaces resolve outside every worktree and are invisible to `git status`;
   - graph sessions register with the `servers` registry and are reaped by `removeWorktree` and the global sweep;
   - `Discard unknown process` cancels the token, releases budgets and leases, and re-evaluates;
   - the token transition map admits exactly four transitions;
   - crash mid-`completing` with a dead process resumes rather than re-executes;
   - each of the five entry-point matrix rows;
   - step-11 quiescence and status flip are one transaction under concurrent completion;
   - an N-ary join firing is all-or-nothing;
   - a busied claim aborts without blocking the event loop and is retried next tick;
   - a completion whose wake-up is lost is scheduled by the periodic sweep;
   - migration atomicity under `BEGIN IMMEDIATE` with an interrupted prior run;
   - `deleteTicket` removes graph rows and bytes; archive removes neither;
   - graph launches open `process_runs` rows and usage is recorded once;
   - a model without `efforts` rejects an effort value; an OpenCode profile with both model and effort is rejected at Save;
   - the compile repair loop stops at 3 attempts and charges no planner-run budget;
   - a `replan` with no qualifying lineage evidence is treated as `blocked`.
6. Keep the closing rule that a later slice cannot weaken a prior slice's invariants, and add the new invariant classes to it: lease, workspace-location, and capability-rotation invariants.

#### Constraints
- Do not renumber the six slices; amend their contents in place.
- Do not remove any existing verification bullet.

#### Edge Cases
- A verification bullet that duplicates an existing one: merge into the existing bullet rather than adding a near-duplicate line.
- A behavior introduced by a decision but not testable until a later slice: state the slice in the bullet.

#### Verification
```bash
grep -n 'disabled by default' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -n 'Slice 3' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
awk '/## Verification Strategy/,/## Delivery Strategy/' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md | grep -c '^-'
```

Expected:
- The first two print at least one line.
- The third prints a count of at least `112` (the pre-edit count, verified during planning, is `87`; at least 25 bullets are added).

#### Completion Criteria
- [ ] Slice 1 ships the approach disabled; Slice 3 is named as the flip point.
- [ ] Slice 1, 3, and 5 contents amended per items 2–4.
- [ ] All 27 listed verification bullets are present.
- [ ] The no-weakening rule names the three new invariant classes.

---

## Final Verification

1. Confirm no source file changed — this plan is documentation-only.
2. Confirm no open-decision language survives anywhere in the design document.
3. Confirm every accepted finding in the ledger has a task number and every task number 2–17 appears at least once.
4. Confirm all internal document links resolve.
5. Confirm the repository still builds and tests clean, proving nothing under `src/` was touched.

Commands:

```bash
git status --porcelain
git diff --name-only
grep -nEi '\b(either .* or|consider using|probably|as needed|if needed|as necessary|choose the best|appropriate abstraction|something like|etc\.)' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md
grep -oE '\(\./[^)]+\.md\)' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md | tr -d '()' | while read -r f; do test -e "docs/superpowers/specs/$f" || echo "BROKEN: $f"; done
grep -oE '\| Task ([0-9]+)' docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md | sort -u
npm run typecheck
npm test
```

Expected:
- `git status --porcelain` and `git diff --name-only` list only the two spec files and this plan — **no path under `src/`**.
- The open-decision grep prints nothing.
- The link check prints no `BROKEN:` line.
- The ledger task grep prints `Task 2` through `Task 17` with no gaps.
- `npm run typecheck` exits 0.
- `npm test` passes with the same result as before the plan started, since no source changed.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
