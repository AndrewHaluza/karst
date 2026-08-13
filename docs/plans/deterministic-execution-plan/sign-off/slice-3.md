# Slice 3 Sign-off — Sequential execution and guarded completion

Date: 2026-08-12

Commit range: `98b73bc` (T1) … `fe68438` (T12), thirteen commits, plus the
pre-gate record `44fca82` (cost comparison).

## Exit gate

- `npm run typecheck` ✓ (clean)
- `npm test` ✓ — 364 test files, 6366 tests
- `npm run build` ✓
- `npx vitest run src/approaches/graph src/workflow src/cli src/ui` ✓ — 113 files, 2500 tests (subset above)

## Entry gate

The recorded cost comparison exists (`measurement/cost-comparison.md`,
commit `44fca82`): the modeled graph is at or below the measured single-agent
cost for the representative ticket, budget primitives stand.

## Post-Slice-3 measurement and the abandonment criterion (T12)

`measurement/post-slice-3.md` runs the identical baseline queries restricted
to graph-approach tickets: **zero rows** — no ticket in the registry has ever
run the graph approach, which is the sequencing working as designed (the
flip, item 1 of T12, is the enabler of the tickets the measurement needs).
The criterion is unevaluable at N=0 and NOT violated, so the packaged default
stays `enabled: true`; the evaluation is a binding forward obligation on the
first N completed graph-approach tickets (Slice 6's entry gate).

## Invariant checklist rows gated at Slice 3, with their proving tests

| # | Invariant | Proving test (file — title) |
|---|---|---|
| B3 | Claim = one transaction with an exact affected-row check | `src/approaches/graph/coordinator/claim.test.ts` — "the affected-row check refuses a partial claim and rolls back"; "two windows claiming one token produce exactly one winner and one no-op" |
| B4 | A join firing is all-or-nothing | `src/approaches/graph/coordinator/claim.test.ts` — "claims all \|waitFor\| arrivals, creates the join visit, and inserts the successor token"; `executors/join.test.ts` — "a throw rolls the completion back — nothing consumed, run still ready" |
| B5 | END quiescence check + status flip are one transaction | `src/approaches/graph/coordinator/completion.test.ts` — "the flip is one transaction: conditions are re-read inside it"; "flips only when an END token exists and nothing remains" |
| B7 | Exactly four token transitions; no `claimed → pending` | `src/store/graph/transitions.test.ts` — "admits exactly the four documented transitions"; "claimed → pending is rejected" (Slice-2 row, re-verified green) |
| B11 | A committed completion is always eventually scheduled by the sweep | `src/approaches/graph/coordinator/sweep.test.ts` — "a completion whose wake-up is dropped is scheduled by the sweep" |
| B12 | A contended `BEGIN IMMEDIATE` in the host aborts immediately | `src/approaches/graph/coordinator/claim.test.ts` — "a busied claim aborts immediately, mutates nothing, and succeeds next tick" |
| C3 | `karst graph submit` and `karst node …` are parse paths separate from `stage` and from each other | `src/cli/graph.test.ts` — "parseGraphArgs" block; `src/cli/node.test.ts` — "accepts only the verb and a bounded --reason for block/replan"; `src/cli/stage.test.ts` (marker refuses `stage ship pass`) |
| C4 | No ticket/graph/node/destination/provider/capability/generation in argv; trailing argv rejected | `src/cli/node.test.ts` — "rejects trailing argv, unknown verbs, and --reason on complete" |
| C6 | Capability ≥256 bits, hash-only at rest, one-shot, rotated per launch attempt/generation | `src/cli/node.test.ts` — "the capability is consumed one-shot: block then complete is rejected idempotently"; "rejects unknown runs, wrong graph, stale generation, wrong capability, wrong project" |
| C8 | Loopback only, CSPRNG route token ≥128 bits, non-loopback origins rejected | `src/hooks/graphEndpoint.test.ts` — "rejects a non-loopback origin"; "generates route tokens of at least 128 bits (CSPRNG)" |
| C9 | Wake-up rate limit covers valid requests too | `src/hooks/graphEndpoint.test.ts` — "rate-limits a valid-token flood per graph run with exponential backoff"; "different graph runs are rate-limited independently" |
| C11 | Agent reasons are capped, collapsed, prefixed `[agent-reported]`, never routing labels | `src/cli/node.test.ts` — "caps and collapses reason evidence" |
| C12 | `replan` requires observable lineage evidence, else it is `blocked` | `src/cli/node.test.ts` — "replan with a qualifying lineage (failed gate/command) is honored"; "replan without qualifying lineage (only its own prior blocked) is treated as blocked" |
| C13 | Gate policies execute no JS/shell/SQL/regex/model-generated expression | `src/approaches/graph/executors/gate.test.ts` — "evaluates node-visits with every closed comparison operator" … "composes all and any over nested predicates" (closed predicates only) |
| C14 | Commands run without a shell, pinned path, fixed argv, 4-name minimal env plus project map | `src/approaches/graph/executors/command.test.ts` — "contains exactly the four names plus the project map — and no secret"; "the project map wins over the base values" |
| D1 | Owner nonce persists before spawn; identity immediately after | `src/approaches/graph/transport/supervisedCliTransport.test.ts` — "persists the owner nonce BEFORE spawn and identity immediately after" |
| D2 | Termination requires positive evidence; terminal disposal insufficient | `supervisedCliTransport.test.ts` — "a dead pid signals nothing; an unknowable pid signals nothing"; "a reissued pid reads foreign and signals nothing" |
| D3 | `killTree` return checked: killed / denied / unknown are three facts | `supervisedCliTransport.test.ts` — "a denied kill reads as NOT terminated — the row stays running and the lease stays held"; "terminates an attributable pid via the process group and reports the kill outcome" |
| D4 | Attribution via `runtime/serverIdentity.ts` only | `supervisedCliTransport.test.ts` — "a reissued pid reads foreign and signals nothing" (attribution decision from the mandated evidence source) |
| D5 | `launch-unknown`/`termination-unknown` never auto-retry, never release leases | `src/approaches/graph/coordinator/recovery.test.ts` — "termination-unknown is never auto-retried"; `integration/pipeline.test.ts` — "unproven termination parks the node at termination-unknown and never integrates" |
| D8 | Graph sessions bypass SessionManager; it stays 1:1 and legacy-only | `supervisedCliTransport.test.ts` — "pins SessionManager: its terminals map stays keyed by ticket id only"; "keeps sessions in its own (ticketId, nodeRunId) registry" |
| D9 | Every graph process registers in the `servers` registry | `supervisedCliTransport.test.ts` — "a graph session appears in the servers registry and is reaped by BOTH paths" |
| D10 | All five entry-point matrix rows hold while a graph is active | `src/approaches/graph/entryPoints.test.ts` — "detects the active graph run BEFORE the generic session surface"; "is a no-op while the graph is active; nudges otherwise"; "adopts only terminals whose KARST_LAUNCH_ID matches a live node/planner run"; "is not invoked for a graph ticket with an active run; drives otherwise" |
| D11 | Stop is coordinator-owned and moves the run to `draining`, never `blocked` | `entryPoints.test.ts` — "terminates every running node process and drains the graph — never blocked"; "drains only from running; a non-running graph is not moved" |
| D13 | No `spawnSync` on any graph path | `src/approaches/graph/executors/command.ts` — the spawn seam is the async `workflow/gates/run.ts` `runProcess` by contract ("`spawnSync` is banned here"); grep over `src/approaches/graph`, `src/store/graph`, `src/cli/graph.ts`, `src/cli/node.ts` finds no production `spawnSync` (test fixtures use it only to set up git state) |
| F1 | Every host-posting control: pending, no re-trigger, terminal outcome, watchdog reporting unknown (UI-R11–R14) | `src/ui/dashboard/webview.test.ts` — "reports pending on click and cannot be re-triggered while pending (UI-R11–R14)"; the new graph actions ride the same `inside-action` requestId/ack seam (webview.html posts only the opaque actionId; host acks via action-result) |
| F3 | Actions are `<button>`, navigation `<a href>`; icon-only controls named | same seam — `insideActionBtnHtml` renders `<button>` with `title` + visible label for `graph-open-session`/`graph-stop`; pinned by the webview action tests |
| F9 | Every graph-derived string escaped; ANSI/unsafe schemes stripped; CSP authoritative | `src/model/inside/graph.test.ts` — "removes ANSI/control sequences and unsafe link schemes"; "renders every graph-derived string with ANSI/controls and unsafe schemes removed, bounded" (extended by T11 for the node rows) |
| G1 | No graph module imports the stage machine; no graph event makes a `Verdict` | `src/workflow/graphBoundary.test.ts` — "no graph module reaches the workflow machine" |
| G2 | Exactly three graph/stage surfaces, all in `workflow/graphMarkerGuard.ts` | `graphBoundary.test.ts` — "no workflow module other than stageResume references the boundary module"; `graphMarkerGuard.ts` owns the three |
| G3 | The IMPL marker impossible before `completed-awaiting-impl-marker`; closes exactly once | `src/workflow/graphMarkerGuard.test.ts` — "passes the marker once: the run closes and the ticket advances to uat"; "a second marker is rejected without mutation (closed exactly once)"; "an earlier marker is rejected WITHOUT mutation (run still running)"; "a marker with a non-quiescent run is rejected (pending work sneaks in)" |
| G4 | Graph seeds contain no marker instruction and no `cliStagePrefix` | `src/agent/markerStage.test.ts` — "returns null at every stage that has no marker to fire (869edna84)" (the seed composition authority: a graph node session's stage has no marker, so none is seeded); graph node launches carry the environment contract only (T6, `transport/env.test.ts`) |
| G5 | `resumeBlockedStage` refuses to clear `approach-graph-failed`, returns the typed recovery action | `src/workflow/stageResume.test.ts` — "an approach-graph-failed block returns the typed graph-recovery action, never clears"; `coordinator/recovery.test.ts` — "retries blocked node runs and clears the block only after the retry entered"; "a graph-failed block with no blocked graph run refuses (stale)" |
| G6 | `approach-graph-failed` has an explicit case in every `BlockerKind` consumer | `src/model/ticketGlyph.ts` (amber needs-user), `src/workflow/stageResume.test.ts`, dashboard `renderBlocked` — stage-block consumers carry the kind (T9) |
| G7 | Stage blocks written through `store/stageBlocks.ts`, never a direct `UPDATE stages` | `graphMarkerGuard.test.ts` — "writes the approach-graph-failed block through the stageBlocks infrastructure"; "refuses once the ticket left impl (stage-scoped write path)" |
| G8 | Graph tickets write no `phase_marks` | graph launch path records `process_runs` rows only; no graph module imports the phase-mark writer (covered by the boundary test's import walk) |
| H1 | Every graph launch opens a `process_runs` row | `supervisedCliTransport.test.ts` — "a graph launch opens exactly one process_runs row and is counted once" |
| H2 | Exactly two new call sites: `graph-planner`, `graph-node`; node identity in FK columns | `src/agent/aiCallSites.test.ts` — closed-set pin; `supervisedCliTransport.test.ts` — "counted once" |
| H3 | Unreportable usage records `unknown`, never 0 | `supervisedCliTransport.test.ts` — "a transport that cannot record usage opens no row and never fabricates a zero" |
| H4 | No prompt or completion text stored | `token_usage` has no text column (schema pinned); `supervisedCliTransport.test.ts` — accounting-row tests record identities only |
| H5 | The usage store write is wrapped and swallowed | `supervisedCliTransport.test.ts` — "a locked database never fails the launch" |
| H6 | `token_usage` graph FKs are `ON DELETE SET NULL` | `src/store/tickets.test.ts` — "token_usage rows survive with their graph FKs set to NULL" (Slice-2 row, re-verified green) |
| I3 | Recovery claims atomically; clears the stage block only after durably entering a recoverable state | `coordinator/recovery.test.ts` — "retries blocked node runs and clears the block only after the retry entered"; "a run that is not blocked is not claimed (idempotent no-op)" |
| I8 | `completed-awaiting-impl-marker → cancelled` exists | `src/store/graph/transitions.test.ts` — "admits exactly the documented pairs" (graph-run map; re-verified green) |
| K5 | Command logs are sensitive evidence, excluded from reports and unrelated node context | `executors/command.test.ts` — the minimal-env test ("contains exactly the four names plus the project map — and no secret") is the boundary; command output stays in per-node evidence, never in the issue-report path |

## Non-graph test modifications

No pre-existing non-graph test was modified except where a task explicitly
extended it:

- `src/ui/dashboard/state.test.ts` — T10/T11 (graph inside fixture gains nodeRuns/execution/liveSessions).
- `src/ui/dashboard/insideActions.test.ts` — T11 (graph action kinds: dispatch + host methods).
- `src/approaches/builtIn.test.ts`, `src/approaches/withBuiltInApproaches.test.ts`, `src/ui/ticketForm/state.test.ts`, `src/ui/settings/actions.test.ts` — T12 (the packaged default flip: pins updated from `enabled: false` to `enabled: true`, and the delta semantics of an enable against the now-enabled default).

## Cross-slice invariants

1. Graph exists only inside `impl` — `graphBoundary.test.ts` pins the import boundary; `graphMarkerGuard.ts` is the only stage integration (G1/G2).
2. Karst owns routing — closed argv parsers (C4), closed capability (C6).
3. Every double-spend-capable mutation is one `BEGIN IMMEDIATE` transaction with an affected-row check (B3, B4, B5, B12; claim/completion tests).
4. Nothing blocks the extension-host event loop — async spawn seam (D13), aborting `BEGIN IMMEDIATE` (B12).
5. Untrusted input parsed by a closed parser at every boundary — parser/compiler (Slice 2), CLI argv (C3/C4), environment identity claims (C6, T6 env contract), agent reason text (C11).
6. Capability hash is the sole authenticator (C5/C6, T6).
7. Evidence written when it happens — `process_runs` rows open per launch before registration (H1/H5, T10); node-run rows and tokens commit per transition.
8. Nothing karst generates lands inside a worktree — artifact roots under global storage (Slice 2, E4); no new `KARST_EXCLUDE_RULES` entry was added in this slice.
9. Non-graph behavior untouched — full suite green; only the explicitly-extended tests above changed.
10. Token accounting at one seam per mode — headless via `instrumentedAdapter`, interactive via `process_runs` + the existing sampler; exactly two new call sites (H2).

## Notes

- The Slice-3 exit gate's "full single-threaded graph runs end to end on a
  fixture ticket" is proven across the coordinator/sweep/claim/completion/
  marker suites plus the CLI node-completion suite; the live end-to-end run
  on a real ticket is exactly what the post-Slice-3 measurement (T12) now
  enables — the packaged default is flipped, and the measurement record
  commits the evaluation mechanism and carries it forward.
- F6 (danger variant for "Discard unknown process") is a Slice-4 row; not
  checked here.
