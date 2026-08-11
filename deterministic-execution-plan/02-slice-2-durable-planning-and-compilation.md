# Slice 2 — Durable Planning and Compilation

**Entry gate:** Slice 1 exit gate holds.
**Ships:** the atomic schema migration, the eight graph tables plus the `token_usage` FK columns, the pure parser/compiler with canonical fingerprints, the durable bootstrap `PlannerRun`, the capability-authenticated `karst graph submit` verb, the compile repair loop, and a read-only Inside projection behind a feature flag. **Nothing executes a node in this slice.**

## Task 1 — Atomic additive migration

**Why:** `migrate()` today has no outer transaction (`src/store/migrations.ts:90`); each step autocommits and idempotency comes only from column guards. A graph migration interrupted midway must leave `user_version` unchanged so the next open re-runs the same guarded steps.

**Files:** `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/db.test.ts`.

**Changes:**
1. Bump `SCHEMA_VERSION` **34 → 35**. The design text says "from its current 33"; the tree says 34 (`migrations.ts:9`). 35 is correct; the design is stale by one and this plan records the correction rather than following the stale number.
2. The new step opens `BEGIN IMMEDIATE` **before reading `user_version`**, runs every guarded DDL statement plus the `user_version` bump inside it, then commits (Decision 21). Only the graph step is wrapped; older steps are not retrofitted.
3. The DDL is **byte-identical** in `schema.sql` (fresh DBs) and in the guarded step (existing DBs). Every statement stays guard-based (`tableColumns`-style checks), so a mid-crash re-run is safe.
4. The same migration adds `token_usage.approach_planner_run_id` and `token_usage.approach_node_run_id`, both nullable, both `ON DELETE SET NULL`, following the existing `implementation_segment_id` / `interactive_usage_sample_id` detachment pattern.
5. Update `db.test.ts`'s hardcoded `user_version` and table-count assertions.

**Tests (RED first):** fresh DB reaches 35 with all eight tables; a DB at 34 migrates to 35; re-open is a no-op; an interrupted transaction leaves `user_version` at 34 and the next open completes; concurrent opens do not corrupt; a partial prior state (some tables present) re-runs cleanly.

**Verification:** `npx vitest run src/store/db.test.ts`; `npm run typecheck`.

## Task 2 — The eight tables, their CHECKs, and their unique indexes

**Files:** `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/graph/*.ts` (new store modules), `src/store/graph/*.test.ts`.

**Tables** (all `INTEGER PRIMARY KEY` rowid aliases; **no `AUTOINCREMENT`**). The rationale is **insert-only**, not append-only: five of the eight update status columns in place through their transition maps and `approach_node_overrides` is user-edited, but none deletes a row outside `deleteTicket`'s explicit sequence, so the largest rowid never decreases and reuse cannot occur. Only `approach_artifact_instances` is append-only in the stronger sense, and that is the artifact contract, not the reason for this choice.

`approach_graph_runs`, `approach_planner_runs`, `approach_graph_revisions`, `approach_node_runs`, `approach_graph_tokens`, `approach_artifact_instances`, `approach_resource_leases`, `approach_node_overrides` — columns exactly as the design's Persistence section enumerates.

**Load-bearing details that are defects if missed:**
- `approach_graph_tokens` represents the entry token as `source_node_run_id INTEGER NULL` **plus** `is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1))`. A closed-value `CHECK` over a nullable FK cannot express "a real reference or the sentinel".
- `approach_resource_leases` carries `UNIQUE(owner_node_run_id, physical_domain)`. Without it, two windows insert duplicate leases and the affected-row checks become enforcement-by-code.
- `approach_graph_runs.ticket_id REFERENCES tickets(id)` with **no cascade**; graph history is immutable evidence.
- The active revision is **derived**, never stored: `SELECT … WHERE graph_run_id = ? AND status = 'active'`, following the read-filtered precedent in `store/mergeChecks.ts`. There is no `active_revision_id` column.
- Uniqueness: one graph run per ticket/stage attempt; one revision number per run; one planner-run number per run; one visit per revision/node; one claimant per token; one successor per `(source_node_run_id, edge_id, fork_instance_id)`; at most one `active` revision per run.
- Closed-value `CHECK`s enforce **membership** only. Transition legality is application code, expressed as the five transition maps in the design and pinned by tests. The node-run map's **rest states** — `failed-to-launch`, `blocked`, `stale` — each carry exactly two exits, `→ launching` (recovery claim: same reserved visit, incremented launch attempt) and `→ cancelled` (drain, or the ticket leaving `impl`); only `completed` and `cancelled` are terminal. A map without those exits makes the recovery table's "retry the same reserved visit" unimplementable, which is a graph that can never be recovered. The graph-run map likewise exits `completed-awaiting-impl-marker → cancelled` when the ticket leaves `impl` before the marker fires.
- Every graph write joins through the ticket and requires current project plus stage attempt.
- All CLI-reachable store helpers stay driver-agnostic: `store.db.prepare(sql).get/all/run`, positional `?` only, no named params, no `.pluck()` — pinned by a test, because the CLI opens with `node:sqlite`.

**Tests (RED first):** each unique index rejects its duplicate; each `CHECK` rejects an out-of-set status; the entry-token shape accepts a null source only when `is_entry = 1`; the derived active-revision read returns at most one row; the four token transitions are the **only** legal ones and `claimed → pending` in particular is rejected; the graph/revision/node-run/lease transition maps admit exactly the documented pairs.

## Task 3 — Pure parser for the generated graph document

**Why:** planner output is untrusted data. Every High-severity injection and coercion class lands here.

**Files:** `src/approaches/graph/parse.ts` + test (pure; imports no store, no vscode, no provider).

**Changes:** parse the versioned JSON into the design's `ApproachNode` / `ArtifactDef` / `ApproachEdge` / `GatePredicate` types, enforcing:
- document size, collection sizes, bounded strings;
- the bounded safe-identifier grammar for node/artifact/edge/profile/repository/command ids; `$planner` and `$entry` are reserved and rejected as user ids;
- **unknown object fields are rejected**, never ignored;
- every numeric value is a finite safe integer inside its field's explicit inclusive min/max — fractions, negatives, `NaN`, and overflow are never coerced;
- artifact paths normalize relative to the runtime-owned artifact root; resource paths relative to their declared repository root; neither accepts absolute paths, empty/dot segments, or `..`;
- Windows-alias rejection — drive/UNC escapes, alternate data streams, reserved device names, trailing dots/spaces, inconsistent case/Unicode-normalization aliases — enforced by **pure-string unit tests over the normalizer**; no Windows runtime support is asserted for V1 (design, Platform scope);
- resource paths denote exact files or directory subtrees, never glob expressions;
- generated nodes cannot carry provider/model/effort — a document that does is rejected, not stripped;
- composite gate-predicate depth and collection size are bounded.

**Tests (RED first):** a table of malformed documents, one per rule, each asserting a **named** diagnostic; a fuzz-style table of numeric edge cases; the reserved sentinels; the Windows alias table; a document with an unknown field at every nesting level.

## Task 4 — Pure compiler, canonicalizer, and fingerprint

**Files:** `src/approaches/graph/compile.ts`, `canonicalize.ts`, `+ tests`. The compiler is **pure and imports no stores** (Decision 29): physical resource domains are resolved by the store/scheduler layer and **passed in as an injected resolved map**.

**Validations** — the design's list, in full: entries exist; supported kinds and policy variants only; every edge source/destination/outcome valid; at least one reachable END path; no unreachable node or artifact; structured fork dominance, join post-dominance, branch completeness, lineage, predecessor equality; no join region inside an SCC and no conditional partial join; a bounded execution count for every fork source per revision with every join's `maxVisits` at least that bound; every schedulable node — **including gates and joins** — carries a finite visit budget, and SCCs carry a finite aggregate visit bound; aggregate budgets within project maxima; the expert-budget rule exactly `spentPlannerRuns + permittedReplans + (bootstrapUnspent ? 1 : 0) + Σ(maxVisits over agent nodes whose profile resolves to 'expert') ≤ maxExpertRuns`, re-checked at replan compile against graph-run-scoped counters, failing as a **compile error**; every referenced profile/repository/command/prompt/input artifact exists; every planner-produced artifact file exists at compile time and every node output has one declared safe destination; command repositories satisfy the trusted definition and each fingerprint/resource claim is pinned; normalized resource paths stay within declared repository roots; all overlaps recorded for scheduler serialization; gate policies reference valid ids and bounded comparison values.

**Edge rules:** every normal outcome of a command/gate/join must have at least one outgoing edge, and agent `complete` always requires one — an omitted normal route is a **compile error**. Agent `blocked`, agent `replan`, and command `infrastructure-error` are reserved control/fault outcomes: with no explicit edge, karst blocks or starts replan rather than stranding a token.

**Canonicalization:** RFC 8785 JCS over the validated, default-expanded document, UTF-8, SHA-256 fingerprint. The stored canonical bytes are **authoritative on reload**; the fingerprint is verified on read and a mismatch **blocks** rather than silently recompiling.

**Warning, never error:** pairwise-overlapping write claims / total agent nodes > 0.5 emits a compile diagnostic so a planner that serializes everything is visible rather than silently slow.

**Tests (RED first):** one rejection test per bullet above; a reference graph whose canonical bytes and fingerprint are pinned and **must not change across dependency upgrades**; the expert-budget formula rejects an over-budget expert node; a join budgeted below its fork's multiplicity is rejected at compile (not deadlocked at runtime); the overlap warning fires as a diagnostic and does not fail compilation.

## Task 5 — Graph run and planner run lifecycle

**Files:** `src/approaches/graph/coordinator/plannerRun.ts` + test; `src/store/graph/plannerRuns.ts` + test.

**Changes:**
1. Creating a graph run for `(ticket, project, impl attempt)` and a durable bootstrap `PlannerRun` happens **before any external work**, in one transaction.
2. The bootstrap planner is not a node in the graph it generates. Initial planning and replanning share one planner-run protocol with distinct immutable run identities.
3. Prompt snapshots (Decision 14): the effective prompt bytes — packaged overlaid with the project override — are snapshotted into content-addressed storage at **planner-run creation** (and, in Slice 3, at node-run creation), using the single-descriptor protocol of Task 7. The launch reads only the snapshot and verifies the recorded SHA-256; a mismatch blocks with `instructions-missing` **before any spend**. An override that fails to read at run creation blocks the same way. Edits to the on-disk prompt take effect on the **next** run, never on a retry of an existing one.
4. Graph run statuses and their transition map exactly as the design's table; the `planning → awaiting-confirmation` path is taken when `confirmGeneratedGraph` is true (packaged default).

**Tests (RED first):** run + planner run are durable before launch; a prompt modified on disk mid-run does not affect the active run; an unreadable override blocks with `instructions-missing` and spends nothing; the graph-run transition map admits exactly the documented pairs.

## Task 6 — `karst graph submit`: a separate closed parse path

**Why:** the invoking agent reads ticket content it did not author, so prompt injection reaches argv. Parser separation is the security property (the repository's existing `parseStageArgs` doctrine).

**Files:** `src/cli/graph.ts` (new), `src/cli/main.ts`, `src/cli/writableStore.ts`, `src/cli/guide.ts` (+ tests), `src/cli/assertMigrated.ts`.

**Changes:**
1. `karst graph submit` accepts **no** path and **no** outcome; it reads and snapshots the fixed planner artifact assigned by the host. Trailing argv is rejected, not ignored.
2. The parser accepts no ticket key/id, stage, attempt, graph/revision/run id, destination, profile, provider, model, effort, artifact root, callback address, timestamp, capability, or launch generation in argv. Every one of those comes from the host-owned environment.
3. It never imports the workflow machine and produces no `Verdict`.
4. Authentication: a single conditional UPDATE requiring project, ticket, stage attempt, graph run, run id, generation, status `running`, and **capability hash** to match one row. Environment identity fields are untrusted claims; the capability hash is the sole authenticator.
5. The capability is a CSPRNG bearer secret ≥ 256 bits; SQLite stores only its hash; plaintext lives only in the supervised process environment and never in argv, URLs, logs, diagnostics, artifacts, UI state, or issue reports. It is consumed one-shot on the first mutating verb and **rotates per launch attempt and generation**, the prior hash invalidated in the same transaction that increments the launch-attempt counter.
6. Fails closed without project identity and a compatible schema range — both older and newer unsupported schemas — and never falls back to an unscoped ticket lookup (`assertMigrated` precedent).
7. `writableStore`'s shim is upgraded for graph verbs to `BEGIN IMMEDIATE` plus a bounded busy timeout, so a concurrent completion surfaces as a retry rather than an unhandled `SQLITE_BUSY` (`src/cli/writableStore.ts:40-42` currently issues plain `BEGIN`).
8. Durable state commits **before** any wake-up.
9. `karst guide` gains the graph verbs. `cli/guide.test.ts` pins the guide to the real CLI, so this is not optional: a new verb fails `npm test` until the guide mentions it.

**Tests (RED first):** a forged capability, a wrong project, a wrong attempt, a stale generation, and a duplicate submission are each an **idempotent rejection** with evidence recorded and no state change; trailing argv rejected; every forbidden argv field rejected; a submit against a stale schema fails closed naming the file and both versions; the guide test passes.

## Task 7 — Artifact snapshot protocol

**Why:** this is the TOCTOU / symlink / FIFO class. Validation and copy must be **one operation per file**.

**Files:** `src/approaches/graph/artifacts/snapshot.ts` + test.

**Protocol (ordered, non-negotiable):** open with `O_NOFOLLOW | O_NONBLOCK`; `fstat` the **opened descriptor**; reject non-regular files, link count > 1, size over the declared `maxBytes`, and media-type mismatch; read from that same descriptor into immutable content-addressed storage; **never re-resolve the path**. `O_NONBLOCK` is what makes a FIFO swapped in by a live writer fail immediately instead of hanging the open; `O_NOFOLLOW` is what makes a symlink swapped in after validation irrelevant.

The **planner process is terminated and its termination proven before its submission snapshot**, exactly as node completion requires — the two flows have the same shape.

Locations (Decision 15), both under extension **global storage**, outside every worktree:
- artifacts: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/artifacts/`
- workspaces: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/workspaces/<nodeRunId>/<repoName>/`

No `KARST_EXCLUDE_RULES` entry is added for them — **that is the reason**, so a later reader does not "fix" a missing rule.

**Tests (RED first):** a symlink, a FIFO, a hardlinked file, a directory, an oversize file, a media-type mismatch, and a mid-flight swap between validation and read are each rejected; a required output whose staging destination already exists refuses the launch; `git status` in every worktree is clean with artifacts present.

## Task 8 — Delete policy and byte ownership

**Files:** `src/store/tickets.ts`, `src/approaches/graph/retention.ts` + tests.

**Changes:** insert the eight tables into `deleteTicket`'s explicit ordered sequence **after `process_runs` and before the older child tables** (`tickets.ts:509-546`), leaf-first, with the ledger already detached by the existing first step. No `ON DELETE CASCADE` is added to any new table's ticket reference; correctness never depends on a cascade firing. `deleteTicket` also removes the ticket's `<globalStorage>/graph/<projectSlug>/<ticketId>/` byte subtree **after** the rows. **Archive removes nothing.** An activation sweep removes subtrees whose graph run is `closed` or whose ticket no longer exists. No per-ticket pruning of a live ticket's history in V1.

**Tests (RED first):** hard delete removes every graph row and the byte subtree; archive removes neither; deleting a ticket mid-execution runs the explicit sequence; `token_usage` rows survive with their graph FKs set to NULL.

## Task 9 — Compile repair loop

**Files:** `src/approaches/graph/coordinator/repair.ts` + test.

**Changes:** a rejected document returns to the **same** `PlannerRun` with the compiler's structured diagnostics as input, up to **3 compile attempts total** for that run, then the run fails to `graph-plan-invalid`. Attempts increment `compile_attempt` on the planner run and create **no** new planner runs, so they cost no planner-run or expert-run budget. A planner returning byte-identical invalid output still terminates at 3; no progress check is attempted. A different invalid document is handled identically, carrying the newest diagnostics forward.

**Tests (RED first):** three attempts then `graph-plan-invalid`; the planner-run counter and expert-run counter are unchanged across all three; the diagnostics of attempt N reach attempt N+1.

## Task 10 — Read-only Inside projection behind a flag

**Files:** `src/model/inside/graph.ts` (new, pure projection), `src/ui/dashboard/*` wiring, tests.

**Changes:** a read-only projection of graph run, revision, planner run, compile diagnostics, and artifact list. No controls yet. Behind a feature flag so the slice ships inert. Every graph-derived label, reason, artifact name, and log line is rendered as text or through the one audited escaper; ANSI/control sequences and unsafe link schemes are removed; the webview CSP stays authoritative.

**Tests (RED first):** an injection fixture — a planner-authored title containing HTML, ANSI, and a `javascript:` URL — renders escaped and bounded; the projection is a pure function of persisted rows.

## Slice verification

```bash
npm run typecheck
npm test
npx vitest run src/store src/approaches/graph src/cli
```

Expected: migration atomic and idempotent under interruption; the parser and compiler reject every enumerated malformed document with a named diagnostic; the canonical fingerprint matches its pinned reference; `karst graph submit` rejects every forged, stale, duplicate, and wrong-scope call idempotently; artifacts snapshot safely and live outside every worktree; `deleteTicket` removes rows and bytes while archive removes neither. `99-INVARIANT-CHECKLIST.md` sections **B (durability and transactions)**, **C (untrusted input)**, and **E (artifact and path safety)** pass.
