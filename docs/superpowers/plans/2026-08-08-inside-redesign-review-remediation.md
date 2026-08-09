# Inside Redesign Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct all 17 findings in `docs/superpowers/inside-redesign-tasks-1-16-review.md` and finish the missing Task 16 preview/verification delivery without regressing the six-stage Inside contract.

**Architecture:** Repair persistence and execution ownership at the store/workflow boundaries first, then correct host reducers and remove the last webview-owned Ship derivation. Finish by adding a development-only fixture preview that consumes production `InsideStageView` data but is unreachable from production dashboard state. Every mutation remains transactional, host-owned evidence remains authoritative, and the webview remains presentation-only.

**Tech Stack:** TypeScript, Vitest, SQLite (`better-sqlite3` in extension/tests and `node:sqlite` in CLI), VS Code extension APIs, HTML/CSS/vanilla JavaScript webviews.

## Global Constraints

- Preserve the six public stages: `scope`, `impl`, `uat`, `review`, `ship`, `done`; Fix remains a causal process, not a peer stage.
- `Verdict = {kind:'passed'} | {kind:'failed';reason?} | null`; null never transitions and missing graph edges throw.
- SQLite is the source of truth. Evidence is appended when produced; verdict/state transitions remain atomic.
- Current PR status must be literally `merged` before Ship can settle or Done can show a completed receipt.
- Token usage is measured only at the agent seam; store no prompt/completion text and never invent token counts.
- All host actions use opaque action IDs; the webview accepts no client-supplied path, URL, repo, PR number, SHA, stage, or process ID.
- Runtime logic remains host-agnostic through injected interfaces. Do not introduce a runtime `vscode` dependency outside extension/UI host boundaries.
- Store helpers reached by the CLI remain driver-agnostic: positional `?`, no named parameters, no `.pluck()`.
- Use TDD for every task. Run the stated failing test before implementation and the focused suite after implementation.
- Preserve unrelated worktree changes. Use `apply_patch` for edits and commit only the files named by the current task.

---

### Task 1: Honor Disabled Process Assignments and Stop Review Deterministically

**Findings covered:** 2, 3, and 13.

**Files:**
- Modify: `src/agent/processAssignment.ts`
- Modify: `src/agent/processAssignment.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/workflow/review/findingsLane.ts`
- Modify: `src/workflow/review/findingsLane.test.ts`
- Modify: `src/workflow/stages/review.ts`
- Modify: `src/workflow/stages/review.test.ts`
- Modify: `src/workflow/uat/tester.ts`
- Modify: `src/workflow/uat/tester.test.ts`
- Modify: `src/workflow/stages/uat.test.ts`

**Interfaces:**
- Produces: `resolveProcessAssignment(...): ProcessAssignmentSnapshot | null`, where null means the configured role is disabled.
- Produces: an explicit findings-lane stopped outcome consumed by `runReview` without aggregation or transition.
- Preserves: one execution-wide Tester observation cap across all repository targets.

- [ ] **Step 1: Write disabled-assignment resolution tests**

Add cases proving `manifest.processes.<role>.enabled === false` returns null for `uat-tester`, `uat-fix`, `review`, and `review-fix`; absent/true remains resolved. Assert `pr-description` keeps its existing behavior because it has no process config key.

```ts
expect(resolveProcessAssignment(manifestWith({ tester: { enabled: false } }), 'uat-tester'))
  .toBeNull();
expect(resolveProcessAssignment(manifestWith({ tester: { enabled: true } }), 'uat-tester'))
  .toMatchObject({ provider: 'claude' });
```

- [ ] **Step 2: Run assignment tests and verify RED**

Run: `npx vitest run src/agent/processAssignment.test.ts`

Expected: FAIL because disabled assignments currently return a snapshot.

- [ ] **Step 3: Narrow assignment resolution and extension wiring**

Change the resolver return type and short-circuit before provider/model resolution:

```ts
export function resolveProcessAssignment(...): ProcessAssignmentSnapshot | null {
  const config = key === undefined ? undefined : manifest.processes?.[key];
  if (config?.enabled === false) return null;
  // existing snapshot resolution
}
```

Change `processFor` to return the nullable process bundle and make UAT/Review dependencies omit the process when null. Do not create or instrument an adapter for a disabled role.

- [ ] **Step 4: Add execution-boundary disabled tests**

In UAT and Review stage tests, inject disabled process resolution and assert:

```ts
expect(adapter.runHeadless).not.toHaveBeenCalled();
expect(listProcessRuns(store, ticketId).filter((r) => r.processId === 'tester' || r.processId === 'review'))
  .toHaveLength(0);
```

The deterministic gate lane must still run; disabled AI must read as configured absence, not a fabricated pass.

- [ ] **Step 5: Write Review cancellation tests**

Add one test with the signal aborted before the first target and one aborting after target one of two. Assert no aggregate verdict, no recovery round, no transition, and the Review process result is `interrupted`.

- [ ] **Step 6: Implement an explicit stopped findings outcome**

Extend the closed lane union with a stopped member, check `signal.aborted` before and after each awaited call, and return it immediately:

```ts
if (input.signal?.aborted) return { kind: 'stopped', reason: 'Review stopped' };
```

Teach `runReview` to finish evidence/process state as interrupted and return `{ kind: 'stopped' }` before `aggregateReview` or recovery trigger construction.

- [ ] **Step 7: Write global Tester-cap tests**

Use two repository targets that each return more than half the cap. Assert the combined persisted observations equal exactly `maxObservations`, preserve target order, and later targets are truncated/omitted after the shared budget reaches zero.

- [ ] **Step 8: Apply one cap across the Tester execution**

Track remaining capacity outside the target loop and pass it to the parser:

```ts
let remaining = maxObservations;
for (const target of targets) {
  const parsed = parseObservations(output, remaining);
  observations.push(...parsed);
  remaining -= parsed.length;
  if (remaining === 0) break;
}
```

- [ ] **Step 9: Run focused tests**

Run: `npx vitest run src/agent/processAssignment.test.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/agent/processAssignment.ts src/agent/processAssignment.test.ts src/extension.ts src/workflow/review/findingsLane.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.ts src/workflow/stages/review.test.ts src/workflow/uat/tester.ts src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts
git commit -m "fix: honor inside process execution controls"
```

---

### Task 2: Restore Canonical Implementation Process Continuity

**Finding covered:** 4.

**Files:**
- Modify: `src/store/processRuns.ts`
- Modify: `src/store/processRuns.test.ts`
- Modify: `src/store/sessionLaunchIntents.ts`
- Modify: `src/store/sessionLaunchIntents.test.ts`
- Modify: `src/store/implementationRuns.test.ts`

**Interfaces:**
- Produces: `reopenProcessRun(store, processRunId, at): boolean` restricted to interrupted process rows.
- Consumes: the stable `implementation_runs.process_run_id` during resume confirmation.

- [ ] **Step 1: Write the complete interrupted-resume lifecycle test**

Create an Implementation launch, confirm SessionStart, interrupt with SessionEnd, prepare/confirm a resume, then mark Implementation done. Assert after resume both the implementation run and the same process-run ID are running with `endedAt = null`; after the marker both are passed.

```ts
expect(resumed.processRunId).toBe(original.processRunId);
expect(processRun(store, original.processRunId)).toMatchObject({ status: 'running', endedAt: null });
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npx vitest run src/store/sessionLaunchIntents.test.ts src/store/implementationRuns.test.ts`

Expected: FAIL because only `implementation_runs` is reopened.

- [ ] **Step 3: Add the constrained process-run reopen helper**

Implement one store operation:

```ts
export function reopenProcessRun(store: Store, id: number): boolean {
  return store.db.prepare(
    "UPDATE process_runs SET status = 'running', ended_at = NULL WHERE id = ? AND status = 'interrupted'",
  ).run(id).changes === 1;
}
```

Do not reopen passed/failed/stale runs.

- [ ] **Step 4: Reopen both records in the existing confirmation transaction**

In the `run.status === 'interrupted'` branch of `confirmSessionLaunchIntent`, update `implementation_runs` and call `reopenProcessRun(store, run.processRunId)` before opening/reattaching the segment. Throw if the paired process cannot be reopened; the transaction must roll back rather than split canonical state.

- [ ] **Step 5: Add invalid-terminal-state tests**

Assert passed and failed process rows cannot be reopened, and a mismatch rolls back the implementation-run update.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/store/processRuns.test.ts src/store/sessionLaunchIntents.test.ts src/store/implementationRuns.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/processRuns.ts src/store/processRuns.test.ts src/store/sessionLaunchIntents.ts src/store/sessionLaunchIntents.test.ts src/store/implementationRuns.test.ts
git commit -m "fix: reopen implementation process on session resume"
```

---

### Task 3: Make Interactive Usage Binding Atomic and Fix-Aware

**Findings covered:** 5 and 14.

**Files:**
- Modify: `src/store/interactiveUsageSamples.ts`
- Modify: `src/store/interactiveUsageSamples.test.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/workflow/tokenUsageAttribution.test.ts`

**Interfaces:**
- Produces: a transaction-local session binding that prefers an active Fix execution owned by the same ticket/provider/provider-session.
- Preserves: duplicate event idempotency and cumulative counter baseline rules.

- [ ] **Step 1: Write a live-Fix attribution test**

Start/confirm an Implementation session, append one usage event, create a recovery round, begin live Fix on the same session, then append another UsageUpdate. Assert the new ledger row is `fix-resume`, references the Fix process run, and has `implementationSegmentId = null`.

- [ ] **Step 2: Write provider/session ownership negative tests**

Prove a running Fix for another ticket, another provider, or an unrelated provider session does not steal the Implementation binding. If the data model cannot currently prove provider-session ownership for a live nudge, add the minimal durable link to the Fix process/round rather than matching “latest running Fix for ticket”.

- [ ] **Step 3: Run attribution tests and verify RED**

Run: `npx vitest run src/store/interactiveUsageSamples.test.ts src/hooks/dispatch.test.ts src/workflow/tokenUsageAttribution.test.ts`

Expected: FAIL because the old confirmed Implementation intent wins.

- [ ] **Step 4: Resolve binding inside the sample transaction**

Move all binding reads below `store.db.transaction(() => {`. Set the function result to `unattributed` and return from the transaction when no owned process exists. Keep duplicate detection, prior baseline lookup, sample insertion, and `token_usage` insertion in that same callback.

- [ ] **Step 5: Prefer an owned active Fix binding**

Resolve the active recovery/Fix process using durable ownership fields, then fall back to the latest confirmed launch intent. Return:

```ts
{
  purpose: 'fix',
  sessionOrigin,
  provider,
  processRunId: fixRun.id,
  implementationSegmentId: null,
}
```

Never infer ownership solely from stage or timestamp.

- [ ] **Step 6: Preserve counter and duplicate behavior**

Rerun existing new/resume/reset/duplicate cases and add an assertion that a duplicate live-Fix event creates neither a second sample nor a second token row.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run src/store/interactiveUsageSamples.test.ts src/hooks/dispatch.test.ts src/workflow/tokenUsageAttribution.test.ts src/store/tokenUsage.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/interactiveUsageSamples.ts src/store/interactiveUsageSamples.test.ts src/hooks/dispatch.test.ts src/workflow/tokenUsageAttribution.test.ts
git commit -m "fix: bind interactive usage to active process ownership"
```

---

### Task 4: Enforce Recovery Ownership and Terminal State

**Findings covered:** 6, 7, 8, and 15.

**Files:**
- Modify: `src/store/recoveryRounds.ts`
- Modify: `src/store/recoveryRounds.test.ts`
- Modify: `src/workflow/fixExecution.ts`
- Modify: `src/workflow/fixExecution.test.ts`
- Modify: `src/workflow/stages/review.ts`
- Modify: `src/workflow/stages/review.test.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/workflow/driveTicket.test.ts`

**Interfaces:**
- Produces: `exhaustRecoveryRound(store, ticketId, roundId, endedAt): boolean`.
- Strengthens: live/closed Fix attachment requires `(round.id, round.ticket_id, status='pending')`.
- Preserves: gate failures have no AI `sourceProcessRunId`; blocking Review findings do.

- [ ] **Step 1: Write cross-ticket attachment tests**

Create tickets A/B and a pending round for B. Attempt `beginLiveFixExecution` and `recordFixLaunchIntent` with ticket A plus B's round. Assert both throw and leave no process run, launch intent, or round mutation.

- [ ] **Step 2: Constrain both attachment paths**

Use the live predicate:

```sql
UPDATE recovery_rounds
SET fix_process_run_id = ?, status = 'fixing'
WHERE id = ? AND ticket_id = ? AND status = 'pending'
```

For the closed path, check `round.ticketId !== input.ticketId` before recording the intent. Keep the live process open and update inside one transaction so failure rolls back the run.

- [ ] **Step 3: Write false-delivery tests**

Have `isLive()` return true and `nudge()` return false. Assert the function does not return `nudged`, the process is interrupted, and the round is interrupted with `endedAt`.

- [ ] **Step 4: Treat false exactly like a thrown delivery failure**

```ts
try {
  if (!nudge(prompt)) throw new Error('live Fix brief was not delivered');
} catch (error) {
  interruptFixExecution(store, roundId, startedAt);
  throw error;
}
```

Do not automatically launch a second session after the tracked live execution has opened; Task 6 defines failed delivery as interrupted.

- [ ] **Step 5: Write Review causal-run assertions**

Run a Review process that returns a blocking finding. Assert the recovery round's `sourceProcessId` is `review` and `sourceProcessRunId` equals the actual findings process run. Add a deterministic gate-failure control asserting null.

- [ ] **Step 6: Thread the findings process ID into trigger creation**

Capture `findingsLane.processRunId` before finishing the outcome and pass it into `recoveryTriggerFor(outcome, reviewProcessRunId)`. Only use it when `fromFindings` is true.

- [ ] **Step 7: Write exhaustion persistence tests**

Drive a pending round where `round === maxRounds`. Assert it becomes `exhausted`, receives `endedAt`, does not call `resumeFix`, and a second drive does not reconsider it as pending.

- [ ] **Step 8: Implement the constrained terminal transition**

```ts
export function exhaustRecoveryRound(store: Store, ticketId: number, roundId: number, endedAt: string): boolean {
  return store.db.prepare(
    "UPDATE recovery_rounds SET status = 'exhausted', ended_at = ? WHERE id = ? AND ticket_id = ? AND status = 'pending'",
  ).run(endedAt, roundId, ticketId).changes === 1;
}
```

Call it in the driver's exhausted branch before logging. Treat an already-terminal round as an idempotent no-op after re-read; do not overwrite `fixing`, `revalidating`, or another terminal status.

- [ ] **Step 9: Run focused tests**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/workflow/fixExecution.test.ts src/workflow/stages/review.test.ts src/workflow/driveTicket.test.ts src/workflow/fixAttempts.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/store/recoveryRounds.ts src/store/recoveryRounds.test.ts src/workflow/fixExecution.ts src/workflow/fixExecution.test.ts src/workflow/stages/review.ts src/workflow/stages/review.test.ts src/workflow/driveTicket.ts src/workflow/driveTicket.test.ts
git commit -m "fix: preserve causal recovery ownership and terminal state"
```

---

### Task 5: Correct Ship Saga Failure and Baseline Handling

**Findings covered:** 9 and 16.

**Files:**
- Modify: `src/integrations/git.ts`
- Modify: `src/integrations/git.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/stages/ship.test.ts`
- Modify: `src/store/shipRuns.test.ts`

**Interfaces:**
- Consumes: persisted worktree base ref/baseline for ticket-scoped pre-Ship commits.
- Produces: clean-worktree only for successful `git status --porcelain` with empty stdout.

- [ ] **Step 1: Write the nonzero-status regression**

Return `{ exitCode: 128, stdout: '', stderr: 'fatal: ...' }` from Git status. Assert Ship throws/parks, creates no “nothing to commit” provenance, and does not push, describe, or create a PR.

- [ ] **Step 2: Split command failure from clean output**

```ts
if (status.exitCode !== 0) {
  throw new Error(describeGitFailure('git status --porcelain', status));
}
if (status.stdout.trim() === '') {
  // genuine nothing-to-commit path
}
```

Use the existing bounded diagnostic convention; do not persist raw unbounded Git prose.

- [ ] **Step 3: Write bounded commit-provenance tests**

Create history `base -> unrelated ancestor -> ticket commit(s)` with the ticket worktree baseline persisted. Assert only commits after the baseline are recorded as `before-ship`, in chronological order, and the repository root history is excluded.

- [ ] **Step 4: Pass an explicit lower bound to `listCommitsFrom`**

Resolve the durable ticket/worktree base SHA or base ref already used by Ship and call:

```ts
listCommitsFrom(git, worktreePath, baselineRef)
```

Do not pass null for ticket-specific provenance. If the baseline cannot be resolved, record an explicit unknown/note or park according to the saga contract; never silently substitute all reachable history.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/integrations/git.test.ts src/store/shipRuns.test.ts src/workflow/stages/ship.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/git.ts src/integrations/git.test.ts src/workflow/stages/ship.ts src/workflow/stages/ship.test.ts src/store/shipRuns.test.ts
git commit -m "fix: bound ship provenance and surface git failures"
```

---

### Task 6: Make Ship and Done Reducers Evidence-Honest

**Findings covered:** 10 and 11.

**Files:**
- Modify: `src/model/inside/ship.ts`
- Modify: `src/model/inside/ship.test.ts`
- Modify: `src/model/inside/done.ts`
- Modify: `src/model/inside/done.test.ts`
- Modify: `src/model/inside/index.test.ts`

**Interfaces:**
- Produces: process aggregation that preserves `note`/partial absence instead of manufacturing pass.
- Consumes: current PR status; only literal `status === 'merged'` is landed.

- [ ] **Step 1: Write process-level note aggregation tests**

Cover all-note, pass+note, pass-only, run+note, and fail+pass evidence sets. Assert all-note is `note`; pass+note is not green (use the existing partial/note representation); pass-only is pass; run/fail retain precedence.

- [ ] **Step 2: Replace the nonempty-means-pass fallback**

Implement explicit precedence over the closed status vocabulary. A pass is allowed only when every required recorded row is pass/skip according to the reducer's contract. Missing/no-record rows remain note.

- [ ] **Step 3: Write literal-merged regressions**

For both Ship and Done, supply current PRs with status `open` and `unknown` plus a non-null `mergedAt`. Assert Merge remains wait/note and Done remains pending. Add a control with status `merged`.

- [ ] **Step 4: Remove `mergedAt` as landing authority**

Use one predicate:

```ts
const isMerged = (pr: CurrentPr): boolean => pr.status === 'merged';
```

Keep `mergedAt` as display metadata only after literal merged status is established.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/model/inside/ship.test.ts src/model/inside/done.test.ts src/model/inside/index.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/inside/ship.ts src/model/inside/ship.test.ts src/model/inside/done.ts src/model/inside/done.test.ts src/model/inside/index.test.ts
git commit -m "fix: keep ship and done evidence honest"
```

---

### Task 7: Remove the Legacy Ship Progress and Flat Renderer

**Finding covered:** 12.

**Files:**
- Modify: `src/model/inside/progress.ts`
- Modify: `src/model/inside/progress.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/stages/ship.test.ts`
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: Ship progress exclusively through `InsideProgressEvent` (`active`, `completed`, `cleared`).
- Removes: `ship-progress`, `SHIP_STEP_ORDER`, `SHIP_BASE_STEPS`, `flattenShipOps`, `shippingView`, and `renderInsideFlat`.

- [ ] **Step 1: Write protocol rejection tests**

Assert `parseDashboardMessage`/panel plumbing no longer accepts or emits `ship-progress`. Assert Ship started/finished/error/cancel events use the same generic Inside progress union as gates and Fix.

- [ ] **Step 2: Write production renderer tests for live Ship**

Feed an authoritative Ship `InsideStageView`, then overlay active and completed Ship process events. Assert the ledger remains present, the live header appears/clears, the completed process replaces its row, and no per-repository step is derived from raw progress in the webview.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npx vitest run src/model/inside/progress.test.ts src/workflow/stages/ship.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/webview.test.ts`

Expected: FAIL while the legacy variant/fallback is active.

- [ ] **Step 4: Translate Ship callbacks into generic progress events**

At the host/workflow boundary, emit host-formatted `LiveOperationView` on start and a complete `InsideProcessView` on finish. For cancellation/snapshot supersession emit `cleared`; never send raw repo/step structures to the webview.

- [ ] **Step 5: Delete the legacy protocol and derivation**

Remove the message union/parser/panel branch, extension forwarding, `shipping` state, Ship constants/helpers, and the `if (shipping && sel === 'ship')` renderer branch. `renderInside` must always consume `state.insideViews[sel]` plus generic overlays.

- [ ] **Step 6: Add source guards**

In `webview.test.ts`, assert the source does not contain:

```ts
expect(source).not.toMatch(/SHIP_STEP_ORDER|flattenShipOps|shippingView|renderInsideFlat/);
```

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run src/model/inside/progress.test.ts src/workflow/stages/ship.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/state.test.ts src/ui/dashboard/webview.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/model/inside/progress.ts src/model/inside/progress.test.ts src/workflow/stages/ship.ts src/workflow/stages/ship.test.ts src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts src/extension.ts
git commit -m "refactor: route live ship through inside ledger"
```

---

### Task 8: Preserve Configured Identity Until Execution Exists

**Finding covered:** 17.

**Files:**
- Modify: `src/model/inside/agent.ts`
- Modify: `src/model/inside/agent.test.ts`
- Modify: `src/model/inside/index.test.ts`

**Interfaces:**
- Produces: `configuredExecution` when no recorded execution snapshot exists, regardless of prepared timeline rows.
- Preserves: recorded segments always win after SessionStart.

- [ ] **Step 1: Write the prepared-but-unconfirmed reducer test**

Build a launch-prepared Implementation timeline with a configured assignment and no confirmed segment. Assert `execution` is absent and `configuredExecution` is present. Confirm a segment and assert recorded execution replaces it.

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `npx vitest run src/model/inside/agent.test.ts src/model/inside/index.test.ts`

Expected: FAIL because timeline presence currently suppresses configured identity.

- [ ] **Step 3: Key fallback identity to execution evidence**

Replace the timeline-based condition with:

```ts
configuredExecution: execution ? undefined : configuredExecution,
```

Do not synthesize an execution snapshot from configuration.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/model/inside/agent.test.ts src/model/inside/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/agent.ts src/model/inside/agent.test.ts src/model/inside/index.test.ts
git commit -m "fix: retain pending implementation identity"
```

---

### Task 9: Complete Task 16 Fixture, Preview, and Verification Delivery

**Finding covered:** 1.

**Files:**
- Create: `src/ui/dashboard/insideFixtures.ts`
- Create: `src/ui/dashboard/insideFixtures.test.ts`
- Create: `src/ui/dashboard/insidePreview.ts`
- Create: `src/ui/dashboard/insidePreview.test.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts` or the existing activation/command registration test
- Modify: `package.json`

**Interfaces:**
- Produces: deterministic checked-in `InsideStageView` fixture matrix for 2/5/10/15/20 repositories and live/error states.
- Produces: development-only `karst.dev.openInsidePreview` using the production renderer/protocol.
- Constraint: production dashboard/state dependency graph must not import `insideFixtures.ts` or `insidePreview.ts`.

- [ ] **Step 1: Write fixture-shape and scale tests**

Define the exported contract before implementation:

```ts
export interface InsidePreviewFixture {
  id: string;
  label: string;
  repositoryCount: 2 | 5 | 10 | 15 | 20;
  stage: InsideStageKey;
  scenario: 'pending' | 'running' | 'passed' | 'failed' | 'waiting' | 'exhausted';
  view: InsideStageView;
}

export function insidePreviewFixtures(): readonly InsidePreviewFixture[];
```

Assert deterministic IDs/order, constant top-level process counts by stage across repo counts, exact bounded `remaining`, long untrusted labels/paths, and coverage of every evidence kind and live/error scenario.

- [ ] **Step 2: Write preview mode-boundary tests**

Define an injected host boundary in `insidePreview.ts` so tests do not import runtime VS Code:

```ts
export interface InsidePreviewHost {
  createPanel(title: string, html: string): PreviewPanel;
}
export function openInsidePreview(host: InsidePreviewHost, fixtures: readonly InsidePreviewFixture[]): void;
```

Assert Development registers/opens the command; Production and Test do not register it; invoking an unregistered/non-development path cannot open a panel.

- [ ] **Step 3: Write dependency-isolation and contribution tests**

Walk imports from normal dashboard state/panel entry points and assert neither fixture nor preview module is reachable. Assert `package.json` contributes `karst.dev.openInsidePreview` and hides it from the production command palette behind the development-only context key.

- [ ] **Step 4: Run new tests and verify RED**

Run: `npx vitest run src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.test.ts`

Expected: FAIL because modules/command do not exist.

- [ ] **Step 5: Implement the deterministic fixture matrix**

Build fixtures only from production `InsideStageView`, `InsideProcessView`, evidence, token, execution, and typed-action shapes. Use stable synthetic IDs and repository names. Do not read/write SQLite, resolve real worktrees, or register executable action targets.

- [ ] **Step 6: Implement the isolated preview panel**

Reuse the production dashboard webview asset/render protocol. Put development controls outside the delivered Inside DOM for stage/scenario, repo count, and widths 300/360/430/normal. The selected fixture must enter through the same message/state render path as a real snapshot.

- [ ] **Step 7: Register the command only in Development mode**

Guard registration with:

```ts
if (context.extensionMode === vscode.ExtensionMode.Development) {
  context.subscriptions.push(vscode.commands.registerCommand(
    'karst.dev.openInsidePreview',
    () => openInsidePreview(previewHost, insidePreviewFixtures()),
  ));
}
```

Keep fixture imports dynamically/localized inside the guarded development branch if necessary to satisfy production dependency isolation.

- [ ] **Step 8: Complete responsive/accessibility source and VM tests**

For every fixture/width, assert no whole-component horizontal scrolling, status/name precede metadata, metadata remains attached to its process, evidence disclosures/actions remain keyboard semantic, all untrusted text is escaped, timeline rail geometry stays centered, and reduced motion disables animation without hiding the spinner ring.

- [ ] **Step 9: Run Task 16 focused tests**

Run: `npx vitest run src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts`

Expected: PASS.

- [ ] **Step 10: Run the complete automated gate**

Run: `npm test`

Expected: all Vitest suites pass with zero failures.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0 and dashboard asset copied to `dist/`.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 11: Perform the manual Extension Dev Host matrix**

Run the checked-in **Run Karst Extension** launch configuration (its pre-launch task runs `npm run dev:extension`). In the Extension Development Host, run **Karst: Open Inside Preview (Development)** and inspect every scenario at 2/5/10/15/20 repositories and 300/360/430/normal widths.

Record in the PR description:

- keyboard disclosure navigation and nested action focus behavior;
- visible focus indicators;
- reduced-motion behavior;
- long names/paths and branch wrapping;
- current-operation active → completed → cleared updates;
- no whole-Inside horizontal scrolling;
- one real ticket confirming production dashboard state is not fixture-backed.

Do not commit generated screenshots unless explicitly requested.

- [ ] **Step 12: Commit**

```bash
git add src/ui/dashboard/insideFixtures.ts src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/insidePreview.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts src/extension.ts package.json
git commit -m "feat: complete inside redesign verification"
```

---

## Final Review Gate

- [ ] Confirm every finding in `docs/superpowers/inside-redesign-tasks-1-16-review.md` maps to a completed task above.
- [ ] Run `rg -n "SHIP_STEP_ORDER|SHIP_BASE_STEPS|flattenShipOps|shippingView|renderInsideFlat|ship-progress" src/ui/dashboard src/extension.ts` and confirm no legacy live-Ship derivation remains.
- [ ] Run `rg -n "status === 'merged'|mergedAt" src/model/inside/ship.ts src/model/inside/done.ts` and confirm `mergedAt` is display-only.
- [ ] Run `rg -n "status = 'exhausted'" src/store src/workflow` and confirm a production writer exists with ticket/round/status constraints.
- [ ] Run the complete automated and manual Task 16 gates again after any review fix.
- [ ] Request code review against the original 16-task plan, the remediation review, and this plan; fix all Critical/High findings before merge.
