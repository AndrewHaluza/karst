# Slice 3 — Sequential Execution and Guarded Completion

**Entry gate:** Slice 2 exit gate holds **and** the worked cost comparison required by the design's Premise and Measurement section is recorded in `docs/plans/deterministic-execution-plan/measurement/cost-comparison.md`. If that comparison does not exist, Slice 3 does not start — deliberately. If it shows the graph costing materially more for an equal outcome, the budget primitives are revisited before this slice ships.

**Ships:** atomic activation claims, the four executors at `maxParallel: 1`, the supervised transport with proven termination, immutable change sets and canonical integration, graph-aware Resume, the transactional IMPL marker guard, and the flip of the packaged default to `enabled: true`.

## Task 1 — Activation tokens and the claim transaction

**Files:** `src/approaches/graph/coordinator/claim.ts`, `src/store/graph/tokens.ts` (+ tests).

**Changes:**
1. Persist activation tokens: source node run, edge, destination, revision, fork-lineage stack, claim/consumption status. Synthetic entry tokens have no source and share the root fork instance (`is_entry = 1`).
2. Claiming is transactionally single-winner across windows. In one `BEGIN IMMEDIATE` transaction: move the token `pending → claimed`, create or reserve its node-run visit, reserve graph/node/expert/concurrency budgets, acquire durable physical-resource leases, and store the claiming run. Scheduling continues **only when exactly the expected number of rows changed** — 1 for a single activation, `|waitFor|` for a join firing.
3. External launch occurs **after commit**, never inside the transaction.
4. Completion transactionally moves `claimed → consumed`, records the effective outcome, updates counters, and inserts successor tokens with the uniqueness constraint on `(source_node_run_id, edge_id, fork_instance_id)`.
5. A launch retry **reuses** the reserved node-run/visit and increments a launch-attempt counter; it does not create another logical visit and does not move the token back to `pending` — there is no `claimed → pending` transition.
6. **Lock liveness:** a contended `BEGIN IMMEDIATE` in the extension host **aborts immediately** rather than waiting on a busy timeout, because a synchronous wait blocks the shared event loop. The aborted claim counts nothing, mutates nothing, and is retried on the next tick, within the ≤100-transitions-per-tick cap.
7. Non-join nodes consume one token per visit; a non-join node reached by distinct activations runs once per activation. Fan-in that must synchronize uses an explicit join.

**Tests (RED first):** two concurrent windows claiming one token produce exactly one winner and one no-op; the affected-row check refuses a partial claim; a busied claim aborts without blocking the event loop and succeeds next tick (the `gates/run.test.ts` "leaves the event loop free" pattern); a launch retry increments the attempt counter and creates no second visit; successor insertion is idempotent under a duplicated completion.

## Task 2 — Coordinator sweep and the loopback wake-up

**Files:** `src/approaches/graph/coordinator/sweep.ts`, `src/hooks/graphEndpoint.ts` (+ tests), `src/extension.ts` (wiring only).

**Changes:**
1. A bounded periodic reconciliation rides the **existing background PR sweep** in `extension.ts` — the same precedent that lets `settleShipGates` observe a merge no window performed. Invariant: a completion that committed to the database is always eventually scheduled, even when its wake-up hit a dead port. This is what makes a lost wake-up harmless by construction.
2. The loopback notification is **only a wake-up**. Route token is a CSPRNG value ≥ 128 bits; the listener binds `127.0.0.1`; non-loopback origins are rejected. The endpoint derives bounded routing identity from its host-created target, returns fast, and schedules the coordinator. **No bearer capability appears in the URL.**
3. Wake-ups are rate-limited **per graph run** with exponential backoff, and the cap applies to **valid** requests as well as malformed and stale ones — the URL lives in every agent's environment and is inherited by every process that agent spawns, so a valid-token flood is the realistic attack.
4. The coordinator rereads canonical state before selecting any edge.
5. Scheduling never reads hook delivery: hooks are diagnostics only. A surviving node's hooks going nowhere after a window reload is expected and is logged as one bounded diagnostic, never an error.
6. Sweep work is bounded: ≤ 100 state transitions per tick.

**Tests (RED first):** a completion whose wake-up is dropped is scheduled by the sweep; a non-loopback origin is rejected; a valid-token flood is rate-limited with backoff; the endpoint responds before the coordinator runs; a callback without a committed DB row advances nothing.

## Task 3 — `AgentTransport` and `SupervisedCLITransport`

**Files:** `src/approaches/graph/transport/agentTransport.ts` (interface), `supervisedCliTransport.ts`, `+ tests`.

**Changes:**
1. `AgentTransport` is `capabilities() / start() / terminate()` exactly as the design declares.
2. `SupervisedCLITransport` is the **sole** bridge from `AgentAdapter` to `AgentTransport`. It takes the command/env `buildInteractiveCommand` returns and owns the spawn and supervision on top of it. `AgentAdapter` stays a static command-and-environment builder and gains **no** lifecycle methods. No other module bridges the two interfaces — pinned by an import-graph test.
3. The supervisor persists an **owner nonce before spawn**, then records process group/PID, process start identity, provider session id, and generation **immediately after spawn**.
4. Termination must produce positive process/session lifecycle evidence; terminal disposal alone is insufficient. An ambiguous `launching` crash becomes `launch-unknown`; unknown termination becomes `termination-unknown`. Neither is automatically retried, and neither releases physical-resource leases.
5. `TerminationProof` requires an attributed process-**group** signal via `killTree`, with its return value checked: `killed`, `denied`, and `unknown` are three different facts and `denied` never reads as terminated — the lease stays held and the row stays truthfully `running`.
6. Process attribution uses `runtime/serverIdentity.ts` as the **mandated evidence source** — the implementation invents no probe: live cwd via `/proc/<pid>/cwd` where the OS provides it, else start time via `ps -o lstart=` within `START_TIME_TOLERANCE_MS`, both sides canonicalized through `runtime/pathScope.ts`'s `canonicalPath`. Outcomes map: `dead` → node stale, graph blocks for recoverable retry; `foreign` → row cleared, nothing signalled; `unknown` → `termination-unknown`, leases retained. A missing workspace directory is evidence of removal **only when its parent still stands**.
7. Every graph session and command subprocess registers with the existing `servers` registry keyed by its workspace `cwd`, so `removeWorktree` → `stopServersUnder` and the global `reapStaleServers` sweep both see it. This prevents the 869ed2n50 detached-process class by name.
8. Graph sessions **bypass `SessionManager` entirely** and are keyed `(ticketId, nodeRunId)` in the transport's own registry. `SessionManager` (`src/ui/session.ts`) stays 1:1 and legacy-only; **no key change is made to it**.

**Tests (RED first):** owner nonce persists before spawn and identity immediately after; a `denied` kill leaves the row `running` and the lease held; a reissued pid reads `foreign` and signals nothing; a graph session appears in the `servers` registry and is reaped by both paths; `SessionManager`'s type and key are unchanged (pinned).

## Task 4 — Node executors: agent, command, gate, join

**Files:** `src/approaches/graph/executors/{agent,command,gate,join}.ts` + tests.

**Agent node:** launches a fresh interactive session; receives ticket context, the node base prompt (`karst-graph-node`) prepended ahead of its instructions artifact, the instructions artifact, declared immutable input artifact instances/evidence, and only its own workspace locations. It receives **no prior session id and no prior-node transcript**; a fresh visit never gets `--resume` for another node, even on the same provider. Its resolved provider/model/effort/prompt hash and launch generation are **frozen for that launch attempt**. Core-level automatic model fallback is disabled or overridden per launch and the effective model verified from structured lifecycle data; a core that can neither prevent fallback nor prove which model ran lacks the `exact-model` capability and the node **red-blocks before spending tokens**.

On reported completion the node enters `completing` and does **not** release ownership: karst asks the supervisor to terminate the process tree, verifies termination, snapshots the actual diff per physical repository, and rejects out-of-claim mutations as `resource-claim-violated`. Valid change sets integrate into the ticket's canonical worktrees in deterministic node-run order under a physical-repository exclusive lock. Merge conflicts produce `integration-conflict`, preserve the workspace and canonical worktree, and **never route `complete`**. Unproven termination produces `termination-unknown`, retains the lease, and is never automatically retried.

**Command node:** references a project-configured allowlist id only. At compile the executable resolved to an absolute host path and a fingerprint of path/argv/cwd policy/env-name allowlist/access/timeout/definition version were pinned into the revision. Karst executes **without a shell**: exit `0` → `passed`, non-zero → `failed`, spawn/timeout/infrastructure fault → `infrastructure-error`, and never asks an LLM whether the command passed. Environment is explicit and minimal — `PATH`, `HOME`, `TMPDIR`, `LANG` plus the project-authored `env` map; `process.env` is never inherited and the loopback URL, artifact root, capabilities, provider credentials, callback secrets, editor tokens, and unrelated repository secrets are excluded. Multiple repositories run the same definition once per worktree **serially within the node**, one slot at a time, aggregating: any infrastructure fault wins, else any non-zero exit wins, else `passed`. Stdout/stderr are redacted, bounded, and stored as immutable artifact logs; command logs are sensitive evidence and are never auto-attached to issue reports or unrelated node contexts. All process spawning is async — `spawnSync` is banned on this path (`workflow/gates/run.ts` precedent).

**Gate node:** evaluates the closed predicate set over persisted state — node visit counts, node outcome counts, expert-run counts, `artifact-exists`, and `all`/`any` composition — with the closed comparison operators. No JavaScript, shell, SQL, regex, or model-generated expression executes. Outputs are always `matched`/`not-matched` and both require outgoing edges.

**Join node:** scheduler logic, zero tokens. `mode: all` consumes exactly one arrival from every `waitFor` predecessor **with the same fork instance**, then emits `complete`. A join firing is **one all-or-nothing transaction**: it conditionally claims all correlated arrivals, creates the join visit, and inserts the successor token, aborting with no partial claim if any arrival is not claimable — a join whose arrivals are split across two windows' completion transactions sees only committed tokens, so it claims all `|waitFor|` or none and retries next tick.

**Every logical visit — including zero-token gate and join visits — counts** toward `maxNodeRuns` and the node's `maxVisits`. `maxParallel` counts external processes karst spawns, never an agent's own children.

**Tests (RED first):** fresh-session context carries no transcript and no `--resume`; a fallback-incapable core red-blocks before spend; out-of-claim diff blocks before integration; an integration conflict never routes `complete`; exit-code mapping; per-repository serial execution consuming one slot; the minimal environment contains exactly the four names plus the project map and no secret; gate predicates over each primitive; an N-ary join firing is all-or-nothing under a concurrent window.

## Task 5 — Node completion CLI: `karst node complete | block | replan`

**Files:** `src/cli/node.ts` (new), `src/cli/main.ts`, `src/cli/guide.ts` (+ tests).

**Changes:** a closed parser separate from `stage` **and** from `graph submit`. It accepts only the verb and a bounded `--reason` for `block`/`replan`. It accepts no ticket/graph/revision/node id, destination, profile, provider, model, effort, artifact root, callback URL, timestamp, capability, or generation in argv; trailing argv is rejected. The outcome is validated against the **pinned node definition** in the revision. Evidence text is capped and collapsed and is prefixed `[agent-reported]` in every rendering; it is never a routing label. The capability is consumed one-shot on the **first** mutating verb, so a `block` then `complete` gets an idempotent rejection of the second call. Duplicate, stale, wrong-project, wrong-attempt, wrong-capability, and valid-but-late completions (arriving after the coordinator already resolved the node through user cleanup) are **idempotent rejections**: evidence recorded, no state change. Durable state commits before any wake-up. `karst guide` is updated (pinned by `cli/guide.test.ts`).

**`replan` precondition (Decision 27):** honored only when the activation's causal lineage contains at least one observable precondition — a failed deterministic command/gate outcome, a `resource-claim-violated`, or an `integration-conflict`. A `replan` with no such evidence, **including one whose lineage contains only its own prior `blocked`**, is recorded as evidence and treated as `blocked`.

**Tests (RED first):** each rejection class; one-shot capability across two verbs; an unknown outcome rejected; an agent cannot name a destination; a `replan` without qualifying lineage is treated as `blocked`.

## Task 6 — Environment contract for graph sessions

**Files:** `src/approaches/graph/transport/env.ts` + test.

**Changes:** host-owned values only. `KARST_TICKET_ID` keeps its meaning. `KARST_LAUNCH_ID` carries the **node-run id** (or planner-run id), so `ui/terminalIdentity.ts` re-identifies revived terminals **without modification** — it carries the value opaquely, which is why the key was reused rather than replaced. Two id namespaces therefore share one key, and the discriminator is `KARST_GRAPH_RUN_ID`'s **presence**, never the shape of the value: set on every graph session and on no legacy one. Any consumer that *resolves* the id checks the discriminator first, and a lookup that misses reports not-found rather than falling through to the other namespace. Graph values use new names: `KARST_GRAPH_RUN_ID`, `KARST_GRAPH_REVISION_ID`, `KARST_GRAPH_GENERATION`, `KARST_GRAPH_CAPABILITY`, `KARST_GRAPH_ARTIFACT_ROOT`, `KARST_GRAPH_CALLBACK_URL`, `KARST_GRAPH_DB`, `KARST_GRAPH_PROJECT`. No other key's meaning changes.

Graph planner and node seeds **never** contain the generic IMPL done-marker instruction or `cliStagePrefix`, and no node is authorized to issue a stage marker. (`agent/markerStage.ts` already returns `MarkerStage | null`; a graph session resolves to `null`.)

**Tests (RED first):** the seed for a graph node contains no marker instruction and no `cliStagePrefix`; `terminalIdentity` re-identifies a graph terminal unchanged; a manually opened terminal in a node workspace carries no `KARST_LAUNCH_ID` and is never adopted or counted.

## Task 7 — Entry-point matrix

**Files:** `src/ui/session.ts` call sites, `src/workflow/driveTicket.ts`, `src/extension.ts` (+ tests). Each row is a **testable assertion**:

| Entry point | Behavior while a graph run is `planning`/`running`/`draining` |
|---|---|
| `openSession` (dashboard Open) | Detects the active graph run **before** consulting `SessionManager`, then reveals the planner or a chosen node terminal from the transport's `(ticketId, nodeRunId)` registry; **never spawns**. `SessionManager` holds nothing for a graph ticket, so an unguarded lookup finds no session and falls through to a spawn — that fall-through is the bug this row exists to prevent |
| `nudge` | No-op; the coordinator owns continuation |
| `adoptRevivedSession` | Adopts only terminals whose `KARST_LAUNCH_ID` matches a live node/planner run; never launches |
| `driveTicket` | Not invoked for a graph ticket at `impl`; the coordinator drives |
| `resumeFixSession` | Unreachable at `impl`; belongs to `fix` |

A run in `completed-awaiting-impl-marker` has no active work, so `openSession` behaves normally again — which is what makes the Inside "Complete implementation" action usable beside a refreshed session.

**Stop:** owned by a **coordinator-level controller**, not `DriverController` — a graph ticket at `impl` is never driven by `driveTicket`, so the existing per-run `AbortController` has no routing to it. Stop reaches running node processes through `AgentTransport.terminate` for every node run of the active graph and moves the graph run to `draining`, **never to `blocked`**.

**Tests (RED first):** one test per row, plus Stop draining a running graph and terminating its processes.

## Task 8 — Integration into canonical worktrees

**Files:** `src/approaches/graph/integration/*.ts` + tests.

**Changes:** snapshot the actual diff per physical repository, compare against declared writes, and integrate valid change sets serially under a physical-repository exclusive lock in deterministic node-run order. Physical domains are keyed by **canonical worktree realpath plus Git common-directory identity**, never manifest repository name — multiple repository entries may intentionally share one `repoPath`. Any expansion beyond declared writes requires `replan` or a future explicit claim-expansion protocol; V1 never silently widens a running node's claim. Leases stay held until termination is confirmed **and** the change set is integrated, preserved behind a blocker, or explicitly discarded by the user.

**Doctrine (binding, not re-litigable):** intra-ticket integration is not the retired `merge` stage. That rule is about the **PR boundary**, where a remote, a teammate, and a review sit between karst and the result. Here karst owns both sides, there is no remote, and the conflict is one karst created by fanning work out. `integration-conflict` is therefore a graph blocker, and the PR-landing rule is untouched.

**Tests (RED first):** an out-of-claim file blocks with `resource-claim-violated` before integration; a conflict preserves both trees and blocks; two repository entries sharing one `repoPath` resolve to one physical domain and serialize; integration order is deterministic by node-run order.

## Task 9 — Guarded IMPL marker and the three-surface stage boundary

**Files:** `src/workflow/graphMarkerGuard.ts` (new — **the only** graph/stage boundary module), `src/workflow/stageResume.ts`, `src/store/stageBlocks.ts` call sites, `src/model/types.ts`, `src/model/ticketGlyph.ts`, `src/ui/dashboard/*` (+ tests).

**Changes:**
1. After END quiescence the graph status is `completed-awaiting-impl-marker`. The quiescence check and the status flip are **one `BEGIN IMMEDIATE` transaction** re-reading every condition the rule names: no pending/claimed non-END token, no unsatisfied join, no completing process, no integration operation, no active node run. A read-then-write here lets a concurrent window commit successor tokens in between, after which the marker guard correctly refuses and **no reopen path exists** — the ticket would be stuck.
2. Inside exposes "Complete implementation" as the **only** marker entry point for a graph ticket, because graph seeds carry no `cliStagePrefix` and no refreshed session can fire the normal marker. It runs `GraphImplMarkerGuard`: in the same transaction that calls the existing transition path, require current project/ticket/stage attempt, exactly one active graph run in `completed-awaiting-impl-marker`, and no pending/claimed activations, unsatisfied joins, completing/integrating/active node runs, or held ambiguous-process leases; then mark the graph `closed`. Any earlier marker is rejected without mutation. The graph status is an **entry condition, not a verdict**; the scheduler never writes or infers `passed`.
3. `BlockerKind` gains exactly one member, `approach-graph-failed`, and every consumer gains an explicit case: `needsUser` → amber; dashboard `renderBlocked` → title "Implementation graph blocked" with a **graph recovery** button, not the generic Resume; `resumeBlockedStage` → refuses to clear it and returns the typed graph recovery action; Inside strips → list every blocking planner/node run, not only the projected earliest.
4. `resumeBlockedStage` widens from `boolean` to `{kind:'cleared'} | {kind:'refused'} | {kind:'graph-recovery', ticketId, graphRunId}` and **every caller updates in the same commit**. Today it returns `boolean` and clears any block whose kind is not `awaiting-merge` (`src/workflow/stageResume.ts:31`) — which is exactly why this change is mandatory: the generic path would otherwise clear the graph block. A graph ticket that is also `awaiting-merge` is impossible (`awaiting-merge` belongs to `ship`), so no consumer writes defensive code for it.
5. Stage block writes for `approach-graph-failed` go through the existing `store/stageBlocks.ts` infrastructure, never a direct `UPDATE stages`. A block written after the ticket left `impl` is refused by the existing stage-scoped write path.
6. The stage block projects the **earliest** failure by durable event order while Inside lists every blocking run. The first graph fault stops new launches and drains active work so evidence accumulates without multiplying damage.
7. Recovery is graph-aware: the coordinator atomically claims recovery, rereads current configuration, and clears the visible stage block only after retry/recompile/replan has **durably entered a recoverable state**. It never synthesizes node success, chooses a fallback provider, or advances the stage. The recovery table of the design (category → action) is implemented verbatim, including "a launch retry does not re-snapshot the prompt" and "explicit Resume re-snapshots the effective prompt bytes".
8. The graph/stage integration keeps exactly **three** surfaces, with this module owning the graph-side logic of all three: the marker service, the block write/clear, and the typed recovery action. The third surface has a second file by necessity — `stageResume` stays where it is and holds **no graph logic**, only the recognition that it may not clear `approach-graph-failed` and the return of the typed action defined here. An import-graph test pins both directions: no graph module imports the workflow machine, and no `src/workflow/` module other than `stageResume` references this one.

**Tests (RED first):** `stage impl pass` is rejected before quiescence and closes exactly once afterward in the guarded transaction; step-11 quiescence and flip survive a concurrent completion; each `BlockerKind` consumer has its case; `resumeBlockedStage` refuses to clear `approach-graph-failed`; the import-graph test fails if a fourth surface appears.

## Task 10 — Token accounting for graph launches

**Files:** `src/agent/aiCallSites.ts`, `src/agent/instrumentedAdapter.ts` wiring, `src/store/tokenUsage.ts` (+ tests).

**Changes:** every graph launch — planner and node — opens a `process_runs` row, which the **existing** interactive usage sampler binds to (`interactive_usage_samples.process_run_id` is `NOT NULL REFERENCES process_runs(id)`), so there is exactly one interactive accounting seam rather than a second. `AI_CALL_SITES` gains exactly two members, `graph-planner` and `graph-node`; node identity travels in the new FK columns, not in the call site, because the set is closed and must stay bounded. The resolved profile name is recorded on the node/planner run and usage rolls up to profile by joining through the run — **no new column** for it. A transport that cannot report usage records `unknown`, never a fabricated zero. No prompt or completion text is stored. The store write is wrapped and swallowed so a locked database never fails a launch. No caller double-counts.

**Tests (RED first):** a graph launch opens exactly one `process_runs` row and is counted once; an unreportable transport records `unknown`; a locked DB does not fail the launch; deleting graph history leaves `token_usage` rows with NULL graph FKs.

## Task 11 — Inside controls for a graph ticket

**Files:** `src/model/inside/graph.ts`, `src/ui/dashboard/webview.html`, tests.

**Changes:** replace the generic Launch / Open session / reveal-terminal controls for a graph ticket: Open focuses the planner or a chosen node terminal (never spawns); Stop signals the coordinator to drain; Resume routes through the typed graph recovery action; "Complete implementation" is the only marker entry. The board glyph shows graph state for a graph-running ticket, and a graph-blocked ticket renders the `approach-graph-failed` amber needs-user treatment. Show per-node provider/model/effort/profile, visit counts and budgets, artifacts and command evidence, and the **explicit reason a ready node is serialized rather than parallel** — a persisted reason, so deliberate serialization never looks like a scheduler defect. "Copy diagnostic"/"Open log" never include capabilities, prompt/completion text, secrets, or unredacted command output.

Same UI rules as Slice 1 Task 6 apply, and additionally: a modal or drawer does not close before its action settles (UI-R14b); destructive controls use the danger variant judged by irreversible loss (UI-R10b) — "Discard unknown process" (Slice 4) is destructive; workflow status is icon-only with an accessible name (UI-R28b); interaction state belongs to the control that owns the action, never the row (UI-R09b).

## Task 12 — Flip the packaged default and record the measurement

**Changes:**
1. `src/approaches/builtIn.ts`: `enabled: true`. This is the slice with a runtime behind it — flipping earlier means a ticket picking the approach gets an impl launch with no runtime, which is the failure this sequencing prevents.
2. Run the post-Slice-3 measurement against the Slice-1 baseline on N real tickets and record it in `docs/plans/deterministic-execution-plan/measurement/post-slice-3.md`: implementation wall time, total token cost, human-intervention count, UAT-pass-on-first-attempt.
3. Apply the **abandonment criterion**: if the graph does not improve at least one of the four without worsening the others, revert the flip to `enabled: false` and stop — Slices 4–6 are not built. A result favorable on cost but unfavorable on intervention count falls under the same rule.

**Verification:** the measurement file exists with the same queries as the baseline, and the flip state matches the criterion's outcome.

## Slice verification

```bash
npm run typecheck
npm test
npx vitest run src/approaches/graph src/workflow src/cli src/ui
```

Expected: a full single-threaded graph runs end to end on a fixture ticket — plan → compile → confirm → execute → END → "Complete implementation" → `impl` passes; every rejection class in Tasks 5–9 is idempotent; no non-graph test changed. `99-INVARIANT-CHECKLIST.md` sections **B**, **C**, **D (process and lifecycle)**, **G (stage boundary)**, and **H (accounting)** pass.
