# Dynamic IMPL Graph Runtime Design — Parallel Review Report 2

**Design reviewed:** [2026-08-09-dynamic-impl-graph-runtime-design.md](./2026-08-09-dynamic-impl-graph-runtime-design.md)
**Review timestamp:** 2026-08-09T22:09:00Z
**Reviewer model:** opencode-go/deepseek-v4-flash (6 parallel review agents)
**Review focus:** Security/Trust, Scheduler/Concurrency, Persistence/Schema, Recovery/Reload, Architecture/Modules, Product/UX
**Prior review:** [2026-08-09-dynamic-impl-graph-runtime-REVIEW.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW.md) (mimo-v2.5, 42 findings)

---

## Summary

6 parallel reviewers produced **61 findings** against the hardened 1126-line design (revision 0041e79). Items the hardening already addressed (stageResume refusal, marker-guard placement, CLI parser isolation, per-verb capability validation, FK-vs-archive, quiescence-guard atomicity, launch-unknown blocking) were verified against the current text and are **not** re-raised.

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 15 |
| Medium | 26 |
| Low | 15 |
| Informational | 4 |

The one Critical and most Highs cluster in two places: (a) the **configuration/registry seam** — the documented `approaches:` YAML shape cannot survive the existing manifest pipeline, and the built-in approach has no resolution path through the disk-install-based approach machinery; (b) the **process-ownership seam** — node workspaces, artifact roots, and supervised sessions are not wired into the proven `serverIdentity`/`servers`/`removeWorktree`/terminal-identity machinery, leaving the second-launch and orphaned-process failure classes open. The scheduler/transaction core is judged sound after hardening, with four transaction shapes still unpinned (ambiguous-process cleanup, coordinator quiescence flip, N-ary join claim, busy-lock liveness).

---

## Critical

### C1. Graph configuration YAML cannot round-trip through the existing manifest pipeline
**Section:** Configuration Model / Built-In Approach Lifecycle
**Issue:** The documented `approaches:` entries carry nested `planner`/`profiles`/`commands`/`graph` keys, and enablement uses a `{id, enabled:false}` tombstone. But today `ApproachDef` (`src/manifest/types.ts`) has no such fields, `validateApproaches` (`src/manifest/schema.ts`) requires `label` — so a tombstone entry **fails manifest load** — and unknown keys are silently dropped, destroying every graph field on the first load→save cycle. None of `writeManifest` overlay, `SECTION_FIELDS.approaches`, or `manifest/fixtures.ts` are extended anywhere in the design.
**Recommendation:** Explicitly add the AGENTS.md manifest checklist to Slice 1: extend `ApproachDef` with the graph config block, `validateApproaches` (defaults + closed vocabularies), `writeManifest` overlay, shared fixtures, a round-trip test, and the webview mirror; state that tombstones are written with a registry-supplied `label`.

---

## High

### H1. Completion capability is forgeable by a same-UID sibling and never rotates
**Section:** Completion CLI and Trust Boundary
**Issue:** Any concurrent node process (the design relies on fan-out concurrency) can read `/proc/<pid>/environ` of a running node and steal its capability — and since all CLI identity fields come from the attacker's own env, the capability alone is the entire authenticator. A prompt-injected sibling can forge `block`/`replan` (burning expert budget) or an early `complete`. Launch retries "reuse the reserved node-run/visit" but capability rotation per launch attempt/generation is never stated, so a leaked capability stays valid across retries. The invariant "never placed in artifacts" is unenforceable: the only party that writes artifacts is the process holding the plaintext.
**Recommendation:** Treat artifacts as potentially capability-bearing; consume the capability one-shot on the first mutating verb (`complete`/`block`/`replan`, not only `complete`); rotate it per launch attempt; document the same-UID `/proc` residual in the threat model.

### H2. Planner prompt path remains writable by graph actors
**Section:** Artifacts and Context Policy / Settings and Graph UI
**Issue:** Prompt bytes stay "deliberately late-bound per agent launch" from the live packaged/override path (`.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md` and the `<agentsDir>` override, both inside the worktree). A worker with a repo-wide claim, or a `write`-access command node running against the canonical worktree, can rewrite the planner prompt before a replan — injecting instructions into the highest-trust component, whose artifacts are consumed verbatim by every worker. The out-of-claim diff check runs after the poisoned prompt was consumed.
**Recommendation:** Snapshot the effective prompt (packaged + override) at planner-run creation and verify its hash at launch — the per-invocation prompt-hash plumbing already exists — or read from a path outside agent claims.

### H3. Token-usage attribution for graph nodes requires schema changes absent from the inventory
**Section:** Budgets / Persistence
**Issue:** "`instrumentedAgentTransport` … records provider-reported totals … with graph/planner/node/profile attribution" is incompatible with the current schema: `token_usage` has no graph/node-run columns, `AI_CALL_SITES` is a closed set of site names that cannot carry node-run identity, and `interactive_usage_samples.process_run_id` is `NOT NULL` — interactive graph sessions are unrecordable unless graph launches also open `process_runs` rows. Two interactive accounting seams would violate the "measured once" invariant.
**Recommendation:** Pick one and state it: add nullable `approach_planner_run_id`/`approach_node_run_id` FKs (SET NULL) to `token_usage` in the same migration, and/or specify that every graph launch creates a `process_runs` row the interactive sampler binds to.

### H4. Node workspaces, artifact root, and supervised sessions have no ownership, exclusion, or teardown wiring
**Section:** AgentNode / Artifacts and Context Policy / Reload, Multi-Window, and Stale Process Recovery
**Issue:** Three coupled gaps: (a) node workspaces and the "private per-run artifact root" have no named location — inside a worktree they become visible to `ship`'s plain `git add -A` unless `KARST_EXCLUDE_RULES`/`ensureKarstExcluded` gain entries (the new override path `<agentsDir>/karst-graph-engineering/graph-planner.md` matches no existing rule); (b) the artifact root has no deletion owner (who removes bytes — `deleteTicket`, `removeWorktree`, a sweep?); (c) node agent sessions and per-repo command subprocesses are not `servers` rows, so `removeWorktree`→`stopServersUnder` and the global `reapStaleServers` net cannot see them — the exact 869ed2n50 orphaned-process failure class for a ticket archived mid-graph.
**Recommendation:** Name the artifact-root location (under `/.karst/` or global storage), add explicit exclude-rule entries + `karstExcludes.test.ts` coverage, and require the supervised transport to register each node/planner session with the servers registry (keyed by cwd under the node workspace) so removal and the global reap cover them.

### H5. SessionManager, terminal identity, and ticket-level launch entry points are not made graph-aware
**Section:** Scheduler Runtime / Agent Transport Boundary
**Issue:** `SessionManager` is a hard `Map<number, TrackedSession>` (1:1 ticket→session) whose `openSession` focuses rather than spawns; a graph ticket needs a planner + N concurrent node sessions. The doc's "must be generalized across SessionManager …" names the problem but no shim. Dashboard Open/Resume and boot-time gate Resume would launch a ticket IMPL session mid-graph — per the doc that session IS the planner session, so a stray open is a second planner-context agent writing with no claim, lease, or node run. The new env contract (graph run id, generation, capability, callback) is never mapped onto `KARST_TICKET_ID`/`KARST_LAUNCH_ID` that `terminalIdentity.ts` relies on to re-identify terminals and keep hooks current.
**Recommendation:** Enumerate every existing ticket-level launch entry point (`openSession`, `nudge`, `adoptRevivedSession`, `driveTicket`, `resumeFixSession`) and state the redirect/disable rule while a graph run is active (coordinator claims recovery before any acts); specify the SessionManager key change (ticket,node-run) plus a legacy ticket→planner projection, and the env-key mapping or explicit compat shim.

### H6. Positive process identity protocol is asserted but never specified, and `serverIdentity.ts` is never cited
**Section:** Agent Transport Boundary / Reload, Multi-Window, and Stale Process Recovery
**Issue:** The doc distinguishes "demonstrably dead" from "unknown process-tree death", demands "positive process resolution" for `launch-unknown`/`termination-unknown`, and allows retry only on "proven no process" — but never defines the probe: no evidence hierarchy (/proc cwd vs start-time), no tolerance, no canonicalization, no `unknown` bucket. Implementers will reinvent the `kill(pid, 0)` recollection check and pid-only termination — the exact two failure classes AGENTS.md documents.
**Recommendation:** Cite `runtime/serverIdentity.ts` as the mandated evidence source (live cwd via `/proc`, else `ps -o lstart=` matched within tolerance, canonicalized both sides, `dead`/`foreign`/`unknown` tri-state), with an explicit unknown bucket mapping to `termination-unknown`, and require attributed process-GROUP termination for `TerminationProof`.

### H7. Crash mid-`completing`/mid-`integrating` is in every guard but in no recovery rule
**Section:** Failure Semantics / Reload, Multi-Window, and Stale Process Recovery
**Issue:** `completing`/`integrating` are closed statuses; END quiescence and the marker guard both require "no completing/integrating run" — but the reload bullet list and the recovery matrix define behavior only for `launching`/`running`/dead/pending/draining/blocked. A host crash between reported completion and the consumption transaction leaves a node whose outcome was reported but never committed. Generic "dead → stale → retry" re-executes it (duplicate token spend, duplicate integration); termination-unknown rules block the graph on evidence already in hand.
**Recommendation:** Add explicit reload rules: with a demonstrably dead process, resume the completion pipeline (terminate-verify → snapshot → integrate → consume the already-reported outcome); with an alive process, revert to `running` and let completion proceed.

### H8. A lost completion wake-up never reschedules — no periodic coordinator tick is defined
**Section:** Completion CLI and Trust Boundary / Reload, Multi-Window, and Stale Process Recovery
**Issue:** The loopback endpoint is per-window and the callback URL lives in the launching process's env. After a host crash or window close, the surviving agent's completion commits to the DB but its wake-up hits a dead port. Reconciliation runs "on activation" only — useless if a window was already open — and the only other triggers are the endpoint and user actions. "Bounded scheduler actions per reconciliation tick" implies a tick but never establishes one.
**Recommendation:** Mandate a bounded periodic coordinator reconciliation sweep (ride an existing background timer, e.g. the PR sweep precedent) and state that a lost wake-up never strands a committed completion.

### H9. Migration atomicity claim has no mechanism and contradicts the current `migrate()`
**Section:** Persistence
**Issue:** "The additive schema migration is idempotent and atomic under a cross-window migration lock" — but `src/store/migrations.ts` has no transaction, no lock, and no busy handling; each step autocommits and idempotency comes only from guards. The doc asserts a mechanism that does not exist.
**Recommendation:** Specify exactly: `BEGIN IMMEDIATE` before reading `user_version`, all guarded DDL + `user_version = <new>` inside it, `COMMIT`, relying on better-sqlite3's busy timeout and keeping every statement guard-based so a mid-crash re-run is safe.

### H10. FK/delete policy for the 8 new tables is unspecified against `deleteTicket`'s explicit deletion contract
**Section:** Persistence
**Issue:** The repo's product deletion contract is explicit and load-bearing (`TICKET_CHILD_TABLES`, leaf-first ordering, `token_usage` detached, no cascades). The doc names none of the 8 tables there. Archive is a soft delete so it never fires CASCADE — the real question is hard delete: does graph history die with the ticket or is it detached like the ledger? Artifact bytes (H4) must be covered either way.
**Recommendation:** Declare per-table ON DELETE policy and extend `deleteTicket` + ordering accordingly; state whether DB rows outlive artifact bytes.

### H11. Built-in approach has no resolution seam through the disk-install-based approach machinery
**Section:** Built-In Approach Lifecycle / Selection and Enablement
**Issue:** Every existing consumer is disk-based: `listInstalledIds` (drives `toApproachRows` and `reconcileApproachEnabled`), `resolveApproachPrompt`, `materializeApproach`. "Absence of a project entry means packaged defaults and enabled" with no disk install leaves all of them without a resolution path — and `reconcileApproachEnabled` could disable the built-in on any install/uninstall event unless built-ins count as installed.
**Recommendation:** Specify a single overlay seam (e.g. a `withBuiltInApproaches(manifest)` projection consumed by the ticket form, settings, and launch resolution), where it sits in the dependency diagram, and that `listInstalledIds` includes enabled built-ins.

### H12. Effort capability has no metadata home, yet shipped defaults depend on it
**Section:** Execution policy resolution / Budgets
**Issue:** `ModelOption` carries only `id/label/providers`; `BUNDLED_CATALOG`, the published `model-catalog.json`, and the feed parser have no effort/variant field. The packaged Claude Opus `max` and Sonnet `low` defaults must validate against metadata that does not exist. Bundled `opencode: []` is deliberately empty, so OpenCode effort (= model variant) is unresolvable on default installs (feed opt-in, no default URL).
**Recommendation:** Define the additive catalog schema change (per-model optional effort/variant metadata, two copies kept identical by the pinning test) in Slice 1, and pin shipped `max`/`low` defaults with adapter capability tests before VSIX ship — otherwise the default planner profile fails to launch out of the box.

### H13. Default expert-budget arithmetic leaves zero expert escalation headroom
**Section:** Budgets
**Issue:** Packaged defaults `maxExpertRuns: 3` with `maxReplans: 2`; the compiler "reserves one additional planner run for every permitted replan" and "maxExpertRuns explicitly includes bootstrap and replan planner runs". Bootstrap (1) + 2 reserved replans = 3 = the entire budget: the default configuration can never run a single `expert` agent node. The example graph repeats it (`maxExpertRuns: 2`, `maxReplans: 1`).
**Recommendation:** Default `maxExpertRuns ≥ maxReplans + 2` (e.g. 5 with 2 replans); add a compile-time check that planner-reserved + graph expert nodes fit; fix the example graph's numbers.

### H14. Slice 1 ships the approach enabled before any runtime exists
**Section:** Delivery Strategy
**Issue:** Slice 1 delivers the built-in approach "ships in the VSIX … enabled" with analyzer-only selection, but planner submission, executors, and the guarded marker land in Slices 2–3. A ticket picking the approach in Slices 1–2 gets an impl launch with no graph runtime behind it.
**Recommendation:** Gate the approach's visibility in picker/analyzer/launch behind the same feature flag as the Inside projection until Slice 3 (state explicitly which slice flips the flag), or ship the built-in disabled by default until then.

### H15. Agent self-reported `blocked`/`replan` are the only unvalidated routing outcomes — a deliberate deviation from the deterministic-routing invariant
**Section:** Edge and Activation Model / Node Model
**Issue:** AGENTS.md: routing is never driven by agent self-report. `complete` is validated (outputs, claims), command/gate/join outcomes are deterministic — but `blocked` and `replan` are accepted on self-report alone and route straight into the block/replan protocol, bounded only by budgets. A prompt-injected agent can halt the graph or burn planner budget up to the ceilings.
**Recommendation:** State explicitly that `blocked`/`replan` are budget-bounded self-reports (a documented exception to deterministic routing), or require a minimal observable precondition for `replan` (e.g. at least one failed deterministic gate or `resource-claim-violated`/`integration-conflict` evidence in the causal lineage).

---

## Medium

### M1. Planner-submission snapshot races a live writer — the TOCTOU the node flow avoids
**Section:** Artifacts and Context Policy / Completion CLI and Trust Boundary
**Issue:** The node flow terminates the process tree before snapshot; the planner flow does not — line 649 snapshots `graph.json`/artifacts while the planner process is still alive. Validation (walk → reject links → type/size) and byte-copy re-resolve the path between them; a live planner can swap a file or insert a FIFO (open-block hang).
**Recommendation:** Per-file single-operation copy: open `O_NOFOLLOW`, `fstat` the opened fd, verify type/size/link count, read from the same fd; non-blocking open so a FIFO swap fails instead of hanging; state explicitly whether the planner is terminated before its submission snapshot.

### M2. Replan/block reasons are untrusted agent prose that flow into the next planner's context
**Section:** Immutable Replanning
**Issue:** "The elected plus secondary replan reasons" are fed to the replan planner; the delivery mechanism is unspecified. AGENTS.md documents the precedent failure class (shell-token interpolation). A prompt-injected node can inject instructions into the replan planner through its own reason text.
**Recommendation:** Deliver reasons as a file artifact, never argv; frame them in the planner prompt as untrusted agent-reported text; cap length (already stated).

### M3. Loopback wake-up token security is underspecified
**Section:** Completion CLI and Trust Boundary
**Issue:** "Derives bounded routing identity from its host-created target" — "bounded" is not "high-entropy"; no minimum entropy, no loopback bind/origin check, and the rate limit covers "malformed/stale" requests only — a valid-token flood (the URL is in every agent's env and inherited by every spawned process) is unlimited.
**Recommendation:** CSPRNG route token ≥128 bits, bind 127.0.0.1, reject non-loopback origins, per-graph-run wake-up rate cap with backoff.

### M4. Claimed-token fate and budget release on ambiguous-process cleanup are undefined
**Section:** Persistence — `approach_graph_tokens` / Failure Semantics
**Issue:** `launch-unknown`/`termination-unknown` "require positive process resolution or explicit user cleanup" — but nothing states what cleanup does to the still-`claimed` token and reserved visit: cancel (potentially stranding the edge's successor) or keep claimed. Relatedly, drain "finish/cancel claimed activations" creates cancelled node runs whose visits were already reserved at claim time, and nothing releases those reservations — yet counters are graph-run-scoped and shared across revisions, so a cancelled reservation permanently eats revision N+1's budgets for work that never ran.
**Recommendation:** Define a single cleanup/resolution transaction: conditionally `claimed → cancelled`, mark the node run `cancelled`, release the reserved visit's graph/node/expert budget contributions, release the lease, then re-evaluate (blocking with `graph-topology-deadlock` if the edge is now unsatisfiable); state whether a post-resolution retry reuses the reserved visit with the token kept `claimed`.

### M5. Coordinator-side quiescence flip (step 11) is not pinned as an atomic re-reading transaction
**Section:** Scheduler Runtime
**Issue:** The marker guard's check is properly pinned ("In the same transaction that calls the existing transition path, the guard requires …"), but step 11 — "On END quiescence, mark the graph run completed" — is read-then-write. A concurrent window's completion transaction can commit successor tokens between the coordinator's quiescence read and its status write; the guard then correctly refuses the marker and no reopen transition exists — the ticket is stuck.
**Recommendation:** State that step 11's quiescence check and status flip are one `BEGIN IMMEDIATE` transaction re-reading the line-537 conditions, or define a reopen path for the stuck state.

### M6. Join firing contradicts the single-row claim rule — N-ary arrival claim never defined
**Section:** Edge and Activation Model / Persistence
**Issue:** Claiming is pinned as "Scheduling continues only when exactly one row changed" — written for single activations. A `mode: all` join consumes one correlated arrival from every predecessor as a set: its firing transaction must conditionally claim N tokens plus create the visit and successor atomically, aborting without partial claims. The join case is unaddressed.
**Recommendation:** Generalize the rule to "exactly the expected number of rows changed (1 for activations, |waitFor| for a join firing)" and specify the join firing as one all-or-nothing transaction with no partial-claim commit.

### M7. Compile-time expert-budget check does not reserve expert-profile graph-node visits
**Section:** Graph Compilation and Validation / Budgets
**Issue:** The compile check accounts for spent planner runs and replan reserves only; `maxExpertRuns` also includes "graph agent runs resolved to the `expert` profile". A graph declaring an expert node with `maxVisits: V` compiles even when spent + reserved + V exceeds the ceiling, failing only at runtime after expert tokens were spent.
**Recommendation:** At compile time require `spent + (permitted replans) + Σ maxVisits over expert-resolved nodes ≤ maxExpertRuns`, and across revisions at replan compile.

### M8. No WAL/busy-timeout/retry policy for the now-expected `BEGIN IMMEDIATE` contention
**Section:** Parallel Scheduling / Persistence
**Issue:** Multi-window claiming makes contended immediate transactions the expected case ("correctness never depends on … one open window"), but no liveness policy is stated: better-sqlite3's default 5 s busy window is a synchronous block of the extension-host event loop, violating the "nothing that runs in the extension host may block its event loop" invariant. The CLI's `node:sqlite` writable shim issues plain `BEGIN` with no busy timeout — a concurrent completion surfaces as SQLITE_BUSY, not an "idempotent rejection".
**Recommendation:** Specify WAL mode, a bounded busy timeout well under the event-loop budget (or abort-on-busy → defer to next tick), and that a busied claim counts nothing and is retried on the next reconciliation tick (within the ≤100-transition cap); upgrade the CLI shim to `BEGIN IMMEDIATE` + busy timeout for graph verbs.

### M9. Graph run has no terminal state for abandoned tickets
**Section:** Persistence — `approach_graph_runs`
**Issue:** Status union has no `cancelled`; "a ticket no longer at `impl` cancels unscheduled tokens and prevents new graph work" but the run row itself lands nowhere defined. Also `awaiting-confirmation` has no place in a stated transition map (planning → awaiting-confirmation → running).
**Recommendation:** Add a terminal run-level state and define the transition transaction, mirroring token-level cancel.

### M10. Token status transition map never enumerated
**Section:** Persistence — `approach_graph_tokens`
**Issue:** Not defined: what happens to the claimed token on (a) launch failure with proven no process (retry reuses the reserved visit, but the token stays `claimed` under `one claimant per token`), (b) a node marked stale for recoverable retry, (c) user cleanup of ambiguous processes.
**Recommendation:** Enumerate legal transitions (`claimed→consumed`, `claimed→cancelled` on cleanup/stale-without-retry, and either `claimed→pending` for retry or same-claimant re-claim) and pin them in tests.

### M11. `active_revision_id` is a second source of truth
**Section:** Persistence — `approach_graph_runs` / `approach_graph_revisions`
**Issue:** An `active revision id` column plus "at most one active revision per graph run" (partial unique index) can drift — no CHECK spans tables; the run could point at a superseded revision.
**Recommendation:** Drop the column and derive the active revision (the merge_checks-style read-filtered derivation precedent), or guard every revision-status transition.

### M12. Dual-source schema convention not followed in the doc
**Section:** Persistence
**Issue:** Repo convention: new tables go into `schema.sql` AND a guarded step in `migrations.ts`, with `SCHEMA_VERSION` bumped and `db.test.ts`'s hardcoded version/table-count assertions updated. The doc speaks only of "the new `user_version` commit in one transaction".
**Recommendation:** State the mirror explicitly ("byte-identical DDL in `schema.sql` and the new migration step") and name the db.test.ts assertions to update.

### M13. `approach_resource_leases` has no PK/uniqueness specified
**Section:** Persistence — `approach_resource_leases`
**Issue:** No `id`, no uniqueness — without `UNIQUE(node_run_id, domain)` two windows can insert duplicate leases; "affected-row checks" become enforcement-by-code. Also `ambiguous-process` leases have no stated path to `released`.
**Recommendation:** Declare PK plus `UNIQUE(owner_node_run_id, physical_domain)` and enumerate `held→released` / `held→ambiguous-process` transitions.

### M14. No row-bloat/cleanup policy for immutable history
**Section:** Persistence
**Issue:** Append-only tables with real per-ticket upper bounds (≤1000 tokens, ≤200 node runs, ≤6 revisions, ≤1 GiB artifact bytes) and no statement of whether rows/bytes persist forever (archived tickets keep them indefinitely).
**Recommendation:** State the policy explicitly — graph evidence dies with `deleteTicket`, survives archive, no per-ticket pruning in V1, or a defined prune — with cleanup tests.

### M15. The "physical-repository exclusive lock" is not specified as durable across windows
**Section:** AgentNode / Parallel Scheduling and Resource Claims
**Issue:** Two windows can legitimately reconcile concurrently and complete different nodes concurrently; if the integration lock is an in-memory per-window mutex, both integrate into the same canonical worktree and race. The doc's own "correctness never depends on an in-memory single-flight" must extend to integration.
**Recommendation:** State that integration is serialized by a durable DB-backed lease (e.g. an `approach_resource_leases` row with status `held`) acquired transactionally before the integrate phase.

### M16. "No first fallback" is a global ticket-form behavior change contradicting the compat claim
**Section:** Selection and Enablement / Delivery Strategy
**Issue:** Current create mode pre-selects `recommended ?? approaches[0]` (pinned by `state.test.ts`), and the analyzer "badges but never moves the pick" (pinned by `webview.test.ts`). The design removes both behaviors globally while Verification claims non-graph approaches retain existing behavior "through every delivery slice".
**Recommendation:** State that the default-selection removal and analyzer-moves-pick are deliberate global behavior changes (and update the compat claim + tests), or scope them to graph-approach-eligible tickets.

### M17. Compiler boundary vs physical-domain derivation contradiction
**Section:** Module and Dependency Boundaries / CommandNode
**Issue:** "The compiler never imports stores" but compilation "derives the physical resource domain" — physical domains are "canonical worktree realpath plus Git common-directory identity", a registry/filesystem fact, not a pure function of the graph document. Either the compiler reaches worktree state (violating the arrow) or the derivation must be injected.
**Recommendation:** Move physical-domain derivation to the scheduler/store layer and pass resolved domains into compilation, or annotate the boundary exception.

### M18. "Sole graph/stage integration point" contradicted by the doc itself
**Section:** Module and Dependency Boundaries / Failure Semantics
**Issue:** Besides the marker guard, the coordinator writes and clears the `approach-graph-failed` stage block and routes through `stageResume` — three integration surfaces, "sole" claimed for one.
**Recommendation:** Either list all three as graph/stage integration points or route block write/clear through the guard service so the claim is true.

### M19. New `BlockerKind` ripple across closed switches not enumerated
**Section:** Failure Semantics
**Issue:** `BlockerKind` is a closed union consumed by `needsUser` (amber logic), the dashboard `renderBlocked` title map, `stageResume` (whose boolean return must widen to "typed graph recovery action"), and DriverBoundaryReason-style name lists. The design specifies Resume behavior but not how the graph block reads on each surface.
**Recommendation:** Enumerate every `BlockerKind` switch gaining a case and what each renders, plus the `resumeBlockedStage` signature change.

### M20. "Separately refreshed trusted IMPL session" marker path is unreachable by the doc's own seed rule
**Section:** Scheduler Runtime
**Issue:** "Graph node/planner seeds never contain the generic IMPL done-marker instruction or `cliStagePrefix`" removes `/karst:stage impl pass` from every graph session; yet "a user may also invoke the normal marker from a separately refreshed trusted IMPL session". A session never seeded the marker prefix has no way to fire it.
**Recommendation:** Define what "separately refreshed" means (a session re-including the marker prefix? a host action?) or drop the CLI marker path and state the Inside action is the only marker entry.

### M21. Tombstone path through Settings actions is unspecified
**Section:** Selection and Enablement / Settings and Graph UI
**Issue:** `setApproachEnabled`/`syncApproachEnabled` write approach entries into `manifest.approaches` with no label source for a `{id, enabled:false}` tombstone; `reconcileApproachEnabled` points the flag at `listInstalledIds()` — the built-in must always count as installed (ties to H11).
**Recommendation:** Specify that enable/disable writes go through a registry-aware writer injecting `label`/identity, and that built-ins count as installed in `reconcileApproachEnabled`.

### M22. "Never serializes the complete built-in definition" needs a defined strip algorithm
**Section:** Configuration Model
**Issue:** Settings Save is tab-scoped and serializes the whole `approaches` array; shipping built-in defaults merged with project overrides means the webview must strip packaged values before writing, or a save resurrects the full built-in into the manifest (the stale-baseline/clobber failure class).
**Recommendation:** Define the overlay→diff rule (write only tombstone/override deltas), mirror it in the webview, and pin it with the existing `webview.test.ts` overlay differential test (UI-R34).

### M23. Command allowlist vocabularies are under-specified
**Section:** CommandNode / Configuration Model
**Issue:** Prose promises "cwd policy", "access mode", "permitted environment names" but the closed value sets are never enumerated (read/write? subdir-cwd for monorepos?), and projects cannot express env values — a common `test` needing `NODE_ENV=test`/`CI=true` is unconfigurable even though the project author is already fully trusted with executable+argv.
**Recommendation:** Enumerate the closed cwd/access vocabularies in the schema section and allow bounded, project-authored env values in the allowlist definition.

### M24. Multi-repo commands can exceed `maxParallel` and become unschedulable
**Section:** Budgets / CommandNode
**Issue:** Hard cap "repositories per command ≤ 20" vs "maxParallel ≤ 8"; if per-repo subprocesses run concurrently, a 10-repo command node can never acquire 10 slots and waits on resources forever.
**Recommendation:** Either serialize per-repo subprocesses within a node (1 slot at a time) or add a compile check `repos ≤ maxParallel`.

### M25. Profiles portability is oversold for OpenCode
**Section:** Architectural Rationale / Execution policy resolution
**Issue:** A profile carries a provider-specific `model` and `effort`; pointing `worker` at OpenCode with `effort: low` is a hard configuration failure on default installs (empty bundled opencode catalog, feed opt-in), and for OpenCode model and effort are the same choice (`--variant`) — a profile with both set is semantically conflicting.
**Recommendation:** State that a provider switch requires editing model+effort together, and define the OpenCode rule (effort selects the variant; conflicting model+effort rejected at Save).

### M26. Auto-execution default (`confirmGeneratedGraph: false`) is a steep first-run posture
**Section:** Built-In Approach Lifecycle
**Issue:** Default behavior: a ticket at impl auto-launches an opus-5 `max` planner, compiles, and immediately starts up to 4 concurrent agent sessions with a 24h/200-run envelope, with no way to inspect the graph first (read-only Inside view, no editor).
**Recommendation:** Default `confirmGeneratedGraph: true` for the first graph run per project (or surface a prominent "graph generated — executing" interstitial with Stop), and/or default planner effort `high` until `max` is cost-measured.

---

## Low

### L1. "Host-owned environment values" overstate provenance
**Section:** Completion CLI and Trust Boundary
**Issue:** When the agent spawns the CLI, env identity is agent-supplied (it can set any variable); only the capability is unforgeable. The full-field conditional match makes this safe, but the wording invites a future reviewer to trust env.
**Recommendation:** State that env identity fields are untrusted claims and the capability hash is the sole authenticator.

### L2. Command-node minimal environment set is never enumerated
**Section:** CommandNode
**Issue:** "Values come from host-owned safe variables" — unspecified which. If the loopback URL or artifact root is included, a repo script can wake the coordinator or discover sibling artifact roots.
**Recommendation:** Enumerate the exact env names; explicitly exclude the loopback URL and artifact root (capabilities already excluded).

### L3. Read-side exfiltration should be stated out of scope
**Section:** Security Invariants
**Issue:** Out-of-claim reads are undetectable (no read tracking) and same-UID siblings can read each other's workspaces and user files; the workspace-isolation framing may read as containment.
**Recommendation:** One sentence in Security Invariants: read-side exfiltration by a compromised agent is outside the model; writes are the only policed axis.

### L4. No compile-time bound on fork executions vs join `maxVisits`
**Section:** JoinNode / Graph Compilation and Validation
**Issue:** A `forkFrom` source with fan-in can execute multiple times per revision, firing the join once per fork instance; a join budgeted below its fork's fan-in multiplicity strands the second instance's arrivals in `graph-topology-deadlock` — a statically computable condition.
**Recommendation:** At compile time, bound fork executions per revision and require join `maxVisits` ≥ that bound, or require the fork source to be single-activation.

### L5. "Closed-value CHECKs … enforce the state model" overclaims
**Section:** Persistence
**Issue:** CHECKs enforce membership, never transitions; transition legality is application code.
**Recommendation:** Add explicit per-table transition maps (graph run, revision, node run, token, lease) as the testable contract (also the fix for M4/M9/M10/M13).

### L6. PK types undeclared per table
**Section:** Persistence
**Issue:** All 8 tables say only "id". Since all are append-only, rowid reuse is impossible.
**Recommendation:** Declare `INTEGER PRIMARY KEY` (rowid alias) everywhere and state AUTOINCREMENT is deliberately absent.

### L7. `phase_marks` coexistence remains ambiguous
**Section:** Persistence
**Issue:** "Historical UI evidence for legacy approaches" — but the guarded marker still runs "the existing transition path" and the CLI marker path, both of which write `phase_marks`, so graph tickets will write marks.
**Recommendation:** One sentence: marks continue for graph tickets through the marker flow, or are suppressed — so "legacy-only" isn't misleading.

### L8. "Entry sentinel" token source has no representation
**Section:** Persistence — `approach_graph_tokens`
**Issue:** A closed-value CHECK over a nullable FK column can't express "either a real FK or the sentinel" without an extra column.
**Recommendation:** Specify `source_node_run_id INTEGER NULL` + `is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1))`.

### L9. "Wrong-window" is only definable at the endpoint; the DB write path must be stated window-agnostic
**Section:** Reload, Multi-Window, and Stale Process Recovery
**Issue:** The completion write conditions on project/ticket/attempt/graph/revision/run/generation/status/capability — there is no window field, and must not be: the old window's agent is the legitimate owner after reload.
**Recommendation:** State explicitly that completion writes are window-agnostic by design and "wrong-window" applies solely to the loopback routing identity.

### L10. Hooks of a surviving node process die with its window — graph correctness must be hook-independent
**Section:** Agent Transport Boundary
**Issue:** Hooks post to a per-window port; after the launching window's death, the running agent's hooks go nowhere forever. Completion travels via the CLI, so hooks are presumably diagnostics-only — but that must be explicit.
**Recommendation:** State that graph scheduling never reads hook delivery; log a bounded diagnostic when a hook endpoint is unknown/stale.

### L11. New env contract never mapped onto `KARST_TICKET_ID`/`KARST_LAUNCH_ID`
**Section:** Completion CLI and Trust Boundary
**Issue:** Terminal re-identification across reload and hook re-wiring rely on the existing env keys; the doc adds graph run id/generation/capability/callback but says nothing about the old keys (ties to H5).
**Recommendation:** State the mapping (node-run id as the launch id, or explicit retirement with a compat shim).

### L12. Stop/Resume seam for graph processes is unspecified
**Section:** Budgets and Escalation / Failure Semantics
**Issue:** Existing Stop is a per-run `AbortController` in `driveTicket`/`DriverController` (gate-scoped); graph tickets at `impl` are never driven by `driveTicket`, so "Stop/Resume controls resolve it" has no defined routing from the dashboard Stop to `AgentTransport.terminate`.
**Recommendation:** Specify who owns the graph Stop signal (a coordinator controller, not the stage driver's) and how the dashboard Stop reaches running node processes.

### L13. Scope contradiction between the UI section and Slice 6
**Section:** Settings and Graph UI / Delivery Strategy
**Issue:** The UI section describes structured diagnostics and per-invocation usage as V1 features, while Slice 6 defers "structured diagnostics" and "interactive usage reporting" — graph spend shows `unknown` in the usage UI for Slices 3–5.
**Recommendation:** Mark those two items "Slice 6" in the UI section so reviewers/users don't expect them at V1.

### L14. Inside view transitions for graph tickets are underspecified
**Section:** Settings and Graph UI
**Issue:** No description of what replaces the existing Launch/Open-session/reveal-terminal controls on a graph ticket, nor a board-level glyph/badge for graph-running/blocked tickets.
**Recommendation:** Add a short subsection naming the Inside controls for graph tickets and the board glyph.

### L15. Stored canonical JSON vs fingerprint authority unstated
**Section:** Persistence
**Issue:** Canonical bytes AND SHA-256 are both persisted; which is authoritative on reload is not said.
**Recommendation:** One sentence: stored bytes are authoritative, fingerprint verified on read (or informational only).

---

## Informational

### I1. Parameterized SQL for the new CLI store paths not stated
**Section:** Persistence / Completion CLI
**Recommendation:** State that reason text and gate-predicate values are written via bound positional parameters per the CLI convention, and pin with a test.

### I2. ACP lifecycle reporting must be pinned to "termination evidence, never outcome"
**Section:** Agent Transport Boundary
**Recommendation:** State that an ACP `session-ended` event maps to termination evidence only, and ACP endpoints must be loopback-bound (no remote callback addresses).

### I3. Model defaults verified against the packaged catalog
**Section:** Built-In Approach Lifecycle
**Recommendation:** `claude-opus-5`/`claude-sonnet-5` are present in `BUNDLED_CATALOG`, so the defaults are resolvable; the residual risk is the absent effort metadata (H12) — keep the capability-pinning test in Slice 1.

### I4. Deliverable naming for slice plans
**Section:** Delivery Strategy
**Recommendation:** Name the expected output location (e.g. `.planning/karst-graph-engineering/`) and enumerate per-slice API dependencies.

---

## Recommended Priority

1. **Fix Critical (C1) and High (H1–H15) before implementation planning.** The manifest round-trip (C1) and the process-ownership/registry seams (H4, H5, H6, H11) are the highest leverage: they are the difference between the design wiring into the existing codebase or bypassing it.
2. **Address Medium (M1–M26) during Slice 1–4 planning.** M1–M10 pin transaction shapes the verification strategy's tests are expected to cover; M11–M26 are schema/interface definitions.
3. **Track Low (L1–L15) and Informational (I1–I4) as implementation-time polish and documentation.** None block a slice, but L5's transition maps are the cheap way to pin M4/M9/M10/M13.
