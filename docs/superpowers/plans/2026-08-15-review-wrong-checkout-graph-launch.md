# Review Report — WRONG-CHECKOUT: graph-approach agent node launch path

**Date:** 2026-08-15
**Ticket:** WRONG-CHECKOUT ("Wrong checkout") — `impl` stage, `superpowers:writing-plans` approach
**Reviewed fix branch:** `karst/test/add-e2e-tests-for-dynamic-graphs-add-e2e-tests-for-dynamic-g` (merged into develop; current tree at `bdae9de`, includes #248 graph e2e tests + #249)

## Background

The ticket's report describes ticket 869ehv8y5 ("Add tags for models list") in the graph approach:

- Node run 1 `implement-capabilities` wedged at `launching` (launch_attempt=1, no session, no
  process_run_id, no owner_nonce); the graph run reported `active_processes=1` with nothing running.
- **Root cause:** the node red-blocked at the exact-model capability gate
  (`src/approaches/graph/executors/agent.ts:117`): `supervisedCliTransport` declares
  `exactModel: false` (`supervisedCliTransport.ts:126`), so `runAgentNode` refuses to launch any
  agent node. Planner sessions launch because they call `transport.start` directly, bypassing the gate.
- **Why wedged:** `parkLaunchFailure` parked the node; the recovery sweep auto-retried
  (`launch-retry`, `retryReservedVisits`) moving `blocked → launching` — but nothing re-drives a
  `launching` node: `driveReadyNodeRuns` only claims `ready` nodes, and `reconcileLaunching` only
  runs at activation.

## Review method

Four parallel review sub-agents covered: (1) graph launch / exact-model executor path, (2) planner
submit-decouple fixes, (3) workspace / base-head / domain-key selection, (4) graph e2e test coverage.
Findings were re-checked against the current tree at `bdae9de`.

## Consolidated verdict

**The two root causes in the ticket's report are NOT fixed by the reviewed branch. Both remain live
in the current tree, and #248 now documents them as `it.fails` tests.** What the branch *did* fix
(planner submit/decouple, `acceptSubmittedPlan` idempotency, dead-planner handling) is sound.

---

## Update — fixes landed in `6fa8211`

This report records the pre-fix review snapshot at `bdae9de`. Commit `6fa8211` closed the launch
and workspace findings it identified:

- Exact-model support is now declared by each adapter through `AdapterSurfaces`; the agent-node
  gate reads that per-adapter declaration, rather than a transport-wide `exactModel: false` value.
  The four shipped adapters declare support and conformance tests pin the real argv seam.
- A recovery-rearmed `launching` node with neither an owner nonce nor a process row is re-driven by
  `driveReadyNodeRuns`; reconciliation treats that same shape as provably unspawned rather than an
  ambiguous process. Launch parking releases its reserved process slot, keeps the red-block reason,
  and a lost `launching → running` CAS does not report a successful launch.
- Agent workspaces now match claim-time base heads by physical-domain key, carry the git common-dir
  identity into workspace creation, and decode stored base heads through the hardened store reader.
  Multi-repository launches therefore receive their own recorded base commits rather than the first
  repository's head.
- The graph E2E coverage now runs the real supervised transport capability contract and promotes the
  former `it.fails` cases to passing regressions.

The old `CLAUDE.md` reference to `model/nowLine.ts` is stale: the standalone Now line was removed.
Its former ship decision is now the host-side header-slot model in
`src/model/shipSlot.ts`, rendered from `DashboardState.ship` by the dashboard webview.

The sections below remain the original evidence for why the remediation was required; this update
supersedes their “NOT fixed” and “remaining gap” conclusions.

---

## 1. Graph launch path — NOT fixed

### 1.1 Exact-model gate blocks ALL agent nodes (root cause, still present)

- `src/approaches/graph/executors/agent.ts:117` red-blocks unconditionally:
  `if (!deps.transport.capabilities().exactModel) → { kind: 'red-blocked' }`.
- Both transports hardcode `exactModel: false`:
  - `src/approaches/graph/transport/supervisedCliTransport.ts:126`
  - `src/approaches/graph/transport/acpTransport.ts:238` (ACP not even wired — `ACP_SUPPORTED_CORES` empty)
- There is **no per-adapter `exactModel` surface** (`src/agent/surfaces.ts` has no such field), so no
  core can ever claim the capability. A fifth adapter cannot opt in without editing the transport.
- Consequence: **agent nodes can never launch in the graph approach.** Only the planner launches,
  because `bootstrapAndLaunchPlanner` calls `deps.transport.start` directly (`driver.ts:269`),
  bypassing the gate — exactly the ticket's symptom.
- Self-documented defect: `src/approaches/graph/graph.e2e.test.ts:669` (`it.fails`):
  "the REAL supervised transport declares exactModel:false, so EVERY agent node red-blocks before launch".

### 1.2 The `launching` wedge — NOT fixed

- `driveReadyNodeRuns` selects only `WHERE status = 'ready'` (`driver.ts:743-748`).
- `retryReservedVisits` re-arms `blocked → launching` and bumps `launch_attempt` but writes no
  owner nonce (`recovery.ts:262-325`).
- Nothing re-drives a `launching` node:
  - the post-resume "kick" `maybeDrive` explicitly skips graph tickets (`extension.ts:3037-3040` +
    `shouldDriveGraphTicket` `entryPoints.ts:84-86`);
  - the periodic sweep (`runGraphCoordinatorTick` → `driveGraphRunContinuation`) touches neither
    `launching` nodes nor running-run reconcile;
  - running-run reconcile fires only at activation (`extension.ts:4359`).
- On reload the null-nonce `launching` node becomes `launch-unknown` → `discard-required`
  (`reconcile.ts:260-327`, `recovery.ts:187`) — **terminal**, manual discard required.
- **Misclassification:** `reconcile.ts:253-257` treats "no nonce" as ambiguous (`launch-unknown`),
  but recovery's own re-arm manufactures that shape for a node that was provably never spawned.
- Self-documented defect: `src/approaches/graph/graph.e2e.test.ts:717` (`it.fails`):
  "a node retried to `launching` by the recovery sweep is never re-driven (wedged until a reload)".

### 1.3 Process-slot leak on red-block / retry

- The claim reserved one `active_processes` slot (`claim.ts:237-245`). Slots are released only on
  command-node completion or normal integration. `parkLaunchFailure` (`driver.ts:1053-1074`) never
  releases the slot; every Resume cycle accumulates a held slot until `maxParallel` is exhausted and
  claims start failing with `parallel-slot-busy`. Confirmed by the `it.fails` at `graph.e2e.test.ts:725`.

### 1.4 Red-block reason is discarded

- `driver.ts:905-908` ignores `runResult.reason` (the `exact-model-capability: …` string) and parks
  with generic `'launch failed before the session started'` (`driver.ts:1067`). The dashboard,
  recovery category, and agent context never learn why.

### 1.5 `launching → running` CAS return ignored

- `driver.ts:911-913` drops the `casStatus` return; if the run was blocked between `transport.start`
  and the transition, the node silently stays `launching` while `'launched'` is reported.

---

## 2. Workspace / base-head / domain-key — NOT fixed

- **`heads[0]?.commit` applied to every repo** (`prepareAgentWorkspace`, `driver.ts:957-958`):
  `base_heads` is a per-domain array `{domainKey, commit}[]`; the driver ignores `domainKey` and uses
  one repo's head for every domain. For multi-domain tickets this can silently check out the WRONG
  commit when object stores overlap (verified: `provider.ts:294` `git checkout --detach <baseCommit>`
  succeeds on an existing-but-wrong commit).
- **`gitCommonDir: null`** (`driver.ts:962`): the workspace domain key
  `domainKeyOf(canonicalPath(cwd), null)` can never match `base_heads` keys recorded with the real
  common dir (`extension.ts:3506-3510`, `domains.ts:69-71`). The one surface that could join a
  workspace to its base head is permanently unjoinable.
- **Empty `base_heads` → loud permanent retry loop:** `heads[0]?.commit ?? ''` passes `''` to
  `git checkout -q --detach ''` (git exits 128) → `parkLaunchFailure` → recovery `launch-retry`
  re-launches, but `base_heads` is only written at claim time and is never re-captured on retry, so
  every Resume hits the identical failure forever.
- **`decodeBaseHeads` bypassed:** the driver re-parses inline as an unchecked
  `as { commit: string }[]` instead of using the hardened reader (`nodeRuns.ts:177-192`).
- **Canonical worktree on the wrong branch is unguarded:** `readBaseHeads` captures `git rev-parse
  HEAD` as-is (`extension.ts:3507-3510`); `createWorktree`'s adopt/branch-exists path can attach to a
  stale leftover branch, silently recording a wrong base.

---

## 3. Planner submit-decouple fix (bcd9b42 / a41cd0d / 2c02191 / 6882bbe / 53d89aa) — SOUND

Reviewer verdict on the merged planner lifecycle work:

- **(a) Submit survives terminal death.** Completion is a durable CLI submission (`karst graph
  submit` authenticates via capability hash, commits before wake-up), backstopped by the coordinator
  sweep and every continuation caller re-reading canonical state.
- **(b) Security on the wake-up channel is sound.** Loopback-only listener (`127.0.0.1`), strict
  client-side URL validation (rejects `localhost`, exact path `/graph-wakeup`), `committed`
  detection reads the direct return value of `runCli` (not stdout). Nits: token lookup is not
  constant-time (harmless: capability-only, local attacker can read env), `[::1]` allowlist entries
  are dead vs the IPv4 bind, `routes`/`backoff` maps are never pruned.
- **(c) Double-submit / double-accept are closed** at three layers; `acceptSubmittedPlan` is
  idempotent against an already-active revision, with two `activeRevision` checks + a partial unique
  index on `(graph_run_id) WHERE status='active'`.
- **(d) CLI stdout / exit contract intact.** stdout stays clean JSON; `notifyGraphWakeup` can never
  reject, so it cannot flip the exit code.
- **Residual gap:** the filesystem watchdog added by 2c02191 (poll for `graph.json`) was removed by
  a41cd0d. A planner that stays interactive, writes `graph.json`, and neither runs `graph submit`
  nor exits is left alone indefinitely (only manual terminal close triggers the fallback).
- **Note:** 53d89aa's `reconcileAwaitingConfirmation` was later reverted by bcd9b42 as superseded
  (the durable-submit model needs no awaiting-confirmation dead-planner detection). The ticket's fix
  list still names it; it is dead code in reconcile today.

---

## 4. Test coverage

- `src/approaches/graph/graph.e2e.test.ts` + `graphE2eHarness.test.ts` (added by #248) exercise the
  launch path end-to-end (real CLI + SQLite + git + `driveReadyNodeRuns` → `runAgentNode` →
  `transport.start` → `launching → running`) — but only through `TestTransport` with
  `exactModel: true` (`graphE2eHarness.test.ts:175-176`). The real transport constant is never
  exercised for launch.
- The red-block path through the real transport and the recovery-retry wedge are covered only as
  `it.fails` markers (defects documented, not fixed).
- Unit gaps: `reconcile.test.ts:240-255` encodes the wedge state (`launching`) as expected behavior;
  `driver.test.ts:127` hardcodes `exactModel: true` so the driver red-block path is never exercised;
  `supervisedCliTransport.test.ts` never asserts `capabilities()`.
- Workspace/base-head dangerous paths are untested (no empty-`baseCommit`, no multi-domain differing
  commits; `driver.test.ts:177` mocks `createWorkspace`; agent-launch test inserts no `base_heads`).

---

## Recommended next steps

The writing-plans deliverable for this ticket is an implementation plan addressing the two root
causes, both now pinned by `it.fails` e2e tests:

1. **Make the exact-model capability a real, per-adapter declaration** (add `exactModel` to
   `AdapterSurfaces`, declare on all four adapters which pin `--model`, gate `runAgentNode` on the
   adapter surface) so agent nodes can launch.
2. **Close the `launching` wedge:** re-drive `launching` node runs from the periodic continuation,
   release the process slot in `parkLaunchFailure`, fix the reconcile misclassification of
   null-nonce `launching` nodes, and respect the `launching → running` CAS result.
3. Optionally harden workspace/base-head selection (per-domain key matching, non-empty base
   validation, canonical-worktree branch verification).
