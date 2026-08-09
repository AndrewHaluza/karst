# Inside Redesign Residual Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every residual defect found after the first Inside redesign remediation review, including cancellation safety, recovery ownership, complete process-assignment wiring, repository-fair Tester capping, stable Ship provenance, and executable Task 16 verification.

**Architecture:** Keep correctness decisions at durable host boundaries: Review cancellation becomes an explicit outcome, Fix confirmation validates ticket ownership transactionally, assignment resolution returns typed absence, and usage binds only to a running process. Process configuration is resolved once at each execution boundary and snapshotted into its process run. Task 16 uses a Karst-owned development context key plus executable renderer tests and a recorded Dev Host matrix.

**Tech Stack:** TypeScript, Vitest, SQLite, VS Code extension APIs, vanilla HTML/CSS/JavaScript webviews.

## Global Constraints

- Stop never produces a verdict, recovery round, or transition.
- A process/round/intent association must be constrained by ticket identity inside the transaction that writes it.
- A disabled process performs no AI call, opens no process run, and records no fabricated pass.
- Process identity is resolved once before execution and persisted on the process run; later manifest edits never rewrite history.
- Current worktree state uses the worktree row's persisted `baseRef`; live manifest changes never reinterpret historical provenance.
- Interactive usage may reference only a currently running process owned by the ticket/provider/provider-session.
- The Tester cap is execution-wide and severity-aware without skipping repositories.
- Task 16's preview is registered only in Development mode and must be reachable through its documented command-palette workflow.
- Use test-driven development and preserve unrelated worktree changes.

---

### Task 1: Make Review Cancellation Terminal on Every Adapter Path

**Files:**
- Modify: `src/workflow/review/findingsLane.ts`
- Modify: `src/workflow/review/findingsLane.test.ts`
- Modify: `src/workflow/stages/review.test.ts`

**Interfaces:**
- Preserves: `FindingsLaneOutcome` member `{ kind: 'stopped'; reason: string; processRunId?: number }`.
- Guarantees: an aborted signal cannot return `ran`, including when the adapter rejects.

- [ ] **Step 1: Add an in-flight rejection regression**

Create a one-target findings lane whose adapter waits for `signal.abort`, then rejects with `AbortError`. Assert the lane returns `stopped`, not `ran`, and the stage test asserts interrupted process state, no recovery round, no verdict, and no transition.

```ts
runHeadless: ({ signal }) => new Promise((_, reject) => {
  signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts`

Expected: FAIL because the catch records an ordinary crash and returns `ran`.

- [ ] **Step 3: Check cancellation inside the catch and after the loop**

```ts
} catch (error) {
  if (opts.signal?.aborted) return stopped();
  // existing bounded crash diagnostic
}
if (opts.signal?.aborted) return stopped();
```

Keep non-cancellation adapter failures degraded to bounded crash evidence.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts src/workflow/review/aggregate.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/review/findingsLane.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts
git commit -m "fix: stop review after aborted adapter rejection"
```

---

### Task 2: Close Recovery Confirmation and Usage Ownership Gaps

**Files:**
- Modify: `src/store/recoveryRounds.ts`
- Modify: `src/store/recoveryRounds.test.ts`
- Modify: `src/store/interactiveUsageSamples.ts`
- Modify: `src/store/interactiveUsageSamples.test.ts`
- Modify: `src/hooks/dispatch.test.ts`

**Interfaces:**
- Strengthens: `confirmFixLaunch` validates `(round.id, round.ticketId, round.status)` before opening a process.
- Strengthens: Fix usage requires `process_runs.status = 'running'` and ticket ownership.

- [ ] **Step 1: Add a malformed historical-intent confirmation test**

Insert a pending Fix launch intent for ticket A that references ticket B's pending round using direct test SQL, then call `confirmFixLaunch`. Assert `ticket-mismatch`, no process run, unchanged round, and unconfirmed intent.

- [ ] **Step 2: Run recovery tests and verify RED**

Run: `npx vitest run src/store/recoveryRounds.test.ts`

Expected: FAIL because confirmation trusts the intent's round ID.

- [ ] **Step 3: Validate ownership inside the confirmation transaction**

Extend `ConfirmFixLaunchResult` with `round-mismatch`. Inside the transaction, require:

```ts
const round = roundById(store, intent.recoveryRoundId);
if (!round || round.ticketId !== intent.ticketId || round.status !== 'pending') {
  return 'round-mismatch';
}
```

Constrain attachment with:

```sql
UPDATE recovery_rounds
SET fix_process_run_id = ?, status = 'fixing'
WHERE id = ? AND ticket_id = ? AND status = 'pending'
```

If the update changes zero rows, roll back the opened process and intent confirmation.

- [ ] **Step 4: Add stale-process usage tests**

Create a `fixing` round, mark its process `stale` or `interrupted`, dispatch UsageUpdate, and assert `unattributed` with no sample/token row. Add a running-process control that remains `fix-resume`.

- [ ] **Step 5: Require running process and ticket ownership in both Fix binding queries**

Join `process_runs` with all ownership predicates:

```sql
JOIN process_runs pr
  ON pr.id = r.fix_process_run_id
 AND pr.ticket_id = r.ticket_id
 AND pr.status = 'running'
```

For confirmed Fix intents, also constrain `recovery_rounds.ticket_id = intent.ticketId` and the linked process provider/ticket/status before returning a binding.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/store/interactiveUsageSamples.test.ts src/hooks/dispatch.test.ts src/workflow/tokenUsageAttribution.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/recoveryRounds.ts src/store/recoveryRounds.test.ts src/store/interactiveUsageSamples.ts src/store/interactiveUsageSamples.test.ts src/hooks/dispatch.test.ts
git commit -m "fix: constrain fix confirmation and usage ownership"
```

---

### Task 3: Make Every Process Assignment Executable and Type-Safe

**Files:**
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/workflow/driveTicket.test.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/ui/session.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/stages/ship.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extensionActivation.test.ts`

**Interfaces:**
- Produces: `type DriveProcessBundle = { assignment: ProcessAssignmentSnapshot; adapter: AgentAdapter }` in a shared workflow-facing module.
- Changes: `uatTester` and `reviewProcess` callbacks return `DriveProcessBundle | null` without type assertions.
- Adds: `fixProcess(ticketId, gate): DriveProcessBundle | null` for `uat-fix`/`review-fix`.
- Adds: `prDescriptionProcess(ticketId): DriveProcessBundle | null` for Ship.
- Adds host-only `OpenSessionOptions.assignment?: ProcessAssignmentSnapshot` to launch a configured Fix identity.

- [ ] **Step 1: Write nullable dependency contract tests**

Update driver tests so callbacks explicitly return null. Assert disabled Tester/Review causes no adapter call/process run and remove every `undefined as unknown as DriveProcessBundle` source assertion.

- [ ] **Step 2: Write Fix-role execution tests**

For UAT and Review recovery separately, configure distinct provider/model/agent snapshots. Assert:

- a matching live session is nudged and the Fix process snapshots the configured agent/provider/model;
- a different live identity is not reused as the configured Fix identity;
- a closed session launches with the configured assignment override;
- `enabled: false` performs no launch/nudge and leaves the pending round available for human action without fabricating process evidence.

- [ ] **Step 3: Add typed Fix resolution to the driver boundary**

Change `resumeFix` to receive the resolved bundle:

```ts
resumeFix(
  ticketId: number,
  gate: GateStageKey,
  attempts: number,
  roundId: number | null,
  process: DriveProcessBundle | null,
): void;
```

Resolve role by gate (`uat` → `uat-fix`, `review` → `review-fix`) exactly once. When null, log “configured Fix process disabled” and do not call the session manager.

- [ ] **Step 4: Add host-only session assignment overrides**

Extend `OpenSessionOptions`:

```ts
assignment?: ProcessAssignmentSnapshot;
```

In `karst.openSession`, resolve adapter/provider/model from this host-only assignment when present; otherwise retain ticket/manifest precedence. Never accept this object from a webview message.

If a live session identity differs from the configured Fix assignment, do not label it as that assignment. Launch the configured session through the explicit override path after the existing session is safely retired through the normal session-switch lifecycle.

- [ ] **Step 5: Snapshot configured Fix identity**

Pass `agentName`, provider, and model into `beginLiveFixExecution`; for closed launches persist them on the launch intent and use them when `confirmFixLaunch` opens the process run. Extend the intent schema only if `agent_name` is not currently durable; add a forward migration rather than rewriting v30.

- [ ] **Step 6: Write PR-description assignment tests**

Configure `prDescription` with a distinct identity and assert the Ship description process run snapshots it and uses its adapter. With `enabled: false`, assert no model call/process run and deterministic title fallback remains.

- [ ] **Step 7: Wire PR-description resolution into Ship**

Add a nullable process bundle to Ship options/dependencies. `generateDescription` must use that bundle's adapter and assignment. When null, skip the AI step and use the sanitized deterministic fallback without recording a passed AI process.

- [ ] **Step 8: Run focused tests**

Run: `npx vitest run src/workflow/driveTicket.test.ts src/ui/session.test.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts src/workflow/stages/ship.test.ts src/extensionActivation.test.ts src/agent/processAssignment.test.ts`

Expected: PASS with no unsafe type assertion at the extension seam.

- [ ] **Step 9: Commit**

```bash
git add src/workflow/driveTicket.ts src/workflow/driveTicket.test.ts src/ui/session.ts src/ui/session.test.ts src/workflow/stages/ship.ts src/workflow/stages/ship.test.ts src/extension.ts src/extensionActivation.test.ts
git commit -m "fix: execute every configured inside process assignment"
```

---

### Task 4: Apply the Tester Cap Globally Without Skipping Repositories

**Files:**
- Modify: `src/workflow/uat/tester.ts`
- Modify: `src/workflow/uat/tester.test.ts`
- Modify: `src/workflow/stages/uat.test.ts`

**Interfaces:**
- Produces: stable severity-ranked top N observations across every target.
- Preserves: every configured repository target receives one Tester call unless stopped.

- [ ] **Step 1: Add repository-fair cap tests**

Return 100 low observations from repo A and one critical observation from repo B with cap 100. Assert both adapters run and the persisted result contains the critical observation while remaining exactly 100 rows. Add stable ordering assertions for equal severity.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts`

Expected: FAIL because repo B is never called after repo A consumes the cap.

- [ ] **Step 3: Collect bounded target results and truncate once**

Run every target and parse at most the execution cap from each response to bound memory. After collection, stable-sort by severity (`critical`, `high`, `medium`, `low`) and original target/observation order, then slice once:

```ts
const selected = observations
  .map((finding, order) => ({ finding, order }))
  .sort((a, b) => severityRank(a.finding.severity) - severityRank(b.finding.severity) || a.order - b.order)
  .slice(0, maxObservations)
  .map(({ finding }) => finding);
```

Keep Stop checks before/after each adapter call.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts src/store/uatFindings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/tester.ts src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts
git commit -m "fix: cap tester observations across all repositories"
```

---

### Task 5: Use the Persisted Worktree Baseline for Ship Provenance

**Files:**
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/stages/ship.test.ts`
- Modify: `src/integrations/git.test.ts`

**Interfaces:**
- Consumes: `WorktreeView.baseRef` as the authoritative baseline fixed at worktree creation.
- Does not consume: current manifest base settings for historical before-Ship provenance.

- [ ] **Step 1: Write a manifest-drift regression**

Persist a worktree with `baseRef = 'develop'`, provide a manifest now resolving the repository to `main`, and assert Ship calls `listCommitsFrom`/`rev-list` with `develop..HEAD`. Add a missing persisted baseline case that records unknown provenance rather than substituting the manifest.

- [ ] **Step 2: Run Ship tests and verify RED**

Run: `npx vitest run src/workflow/stages/ship.test.ts src/integrations/git.test.ts`

Expected: FAIL because the current manifest wins.

- [ ] **Step 3: Make persisted baseline authoritative**

Use:

```ts
const provenanceBase = wt.baseRef ?? undefined;
```

Pass it to `listCommitsFrom`. Current manifest resolution may still be used for operations whose contract explicitly needs live configuration, but never to rewrite provenance for the already-created worktree.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/workflow/stages/ship.test.ts src/integrations/git.test.ts src/store/shipRuns.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/ship.ts src/workflow/stages/ship.test.ts src/integrations/git.test.ts
git commit -m "fix: preserve worktree baseline in ship provenance"
```

---

### Task 6: Make the Development Preview Reachable and Record Real Verification

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `src/extensionActivation.test.ts`
- Modify: `src/ui/dashboard/insidePreview.test.ts`
- Modify: `src/ui/dashboard/webview.test.ts`
- Create: `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md`

**Interfaces:**
- Produces: Karst-owned context key `karst.insidePreviewAvailable`.
- Preserves: command registration only when `ExtensionMode.Development`.
- Produces: executable fixture selection/render assertions plus a recorded manual layout matrix.

- [ ] **Step 1: Write context-key and palette tests**

Assert activation executes:

```ts
vscode.commands.executeCommand(
  'setContext',
  'karst.insidePreviewAvailable',
  context.extensionMode === vscode.ExtensionMode.Development,
);
```

Assert `package.json` uses `when: "karst.insidePreviewAvailable"`, and Production/Test still do not register the command.

- [ ] **Step 2: Run activation tests and verify RED**

Run: `npx vitest run src/extensionActivation.test.ts src/ui/dashboard/insidePreview.test.ts`

Expected: FAIL because the current palette condition has no writer.

- [ ] **Step 3: Set and clear the owned context key**

Set it during activation before command registration, use it in `menus.commandPalette`, and clear it during disposal/deactivation if the activation harness requires explicit cleanup. Keep the registration guard unchanged.

- [ ] **Step 4: Add executable fixture/render round-trip tests**

Use the existing VM harness to load real dashboard renderer functions, feed `preview-fixtures`, select each repository count/scenario, and assert the selected `{type:'state'}` snapshot renders escaped hostile fixture strings, semantic disclosure controls, typed actions, and stable process counts. Iterate all 2/5/10/15/20 fixtures and 300/360/430/normal width classes.

Do not claim pixel/layout measurement from VM tests. Keep CSS geometry/overflow assertions as source guards and reserve actual overflow/focus/reduced-motion confirmation for the Dev Host matrix.

- [ ] **Step 5: Run Task 16 automated tests**

Run: `npx vitest run src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.test.ts src/extensionActivation.test.ts`

Expected: PASS.

- [ ] **Step 6: Perform and record the Dev Host matrix**

Launch **Run Karst Extension**, execute **Karst: Open Inside Preview (Development)** from the command palette, and fill `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md` with one checked row for every scenario/repository-count/width combination. Record:

- no whole-Inside horizontal overflow;
- disclosure keyboard activation and focus visibility;
- nested action focus without disclosure toggling;
- reduced-motion spinner remains visible without animation;
- long repository/branch/path wrapping;
- active → completed → cleared live updates;
- one real ticket proving production state is not fixture-backed.

The document must contain the VS Code version, platform, date, tester, and any observed defects. Do not mark unchecked combinations as passed.

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension.ts src/extensionActivation.test.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.test.ts docs/superpowers/verification/2026-08-08-inside-preview-matrix.md
git commit -m "test: complete inside preview verification path"
```

---

### Task 7: Run the Final Remediation Gate

**Files:**
- Modify only if verification exposes a defect; keep each correction in the owning task's files and rerun that task's focused tests first.

**Interfaces:**
- Produces: review-ready branch with every residual finding covered by code, regression tests, and Task 16 manual evidence.

- [ ] **Step 1: Run residual source guards**

Run: `rg -n "undefined as unknown as DriveProcessBundle|extensionMode == development" src package.json`

Expected: no output.

Run: `rg -n "processFor\(.*'uat-fix'|processFor\(.*'review-fix'|processFor\(.*'pr-description'" src/extension.ts`

Expected: all three configured execution roles are wired.

- [ ] **Step 2: Run the complete automated gate**

Run: `npm test`

Expected: all suites pass.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0 and dashboard asset copied.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Audit the closure evidence**

Confirm each residual review item maps to a regression:

- rejected Review abort → stopped;
- malformed cross-ticket Fix intent → rejected atomically;
- stale Fix process → usage unattributed;
- disabled/configured Tester, Review, UAT Fix, Review Fix, and PR Description → correct runtime behavior;
- later critical Tester observation survives the global cap;
- manifest drift cannot change persisted Ship provenance;
- development preview appears in the palette and the manual matrix is complete.

- [ ] **Step 4: Request final code and UI review**

Review against:

- `docs/superpowers/plans/2026-08-08-inside-redesign.md`;
- `docs/superpowers/inside-redesign-tasks-1-16-review.md`;
- `docs/superpowers/plans/2026-08-08-inside-redesign-review-remediation.md`;
- this residual plan;
- the completed preview verification matrix.

Fix every Blocker/High issue, rerun its focused suite, then rerun the complete gate.
