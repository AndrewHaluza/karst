# Usage-Limit Park Offers ('Pick agent/model…' and re-run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a `blocked:usage-limit` park (D158), offer the user actions to 'Pick agent/model…', 'Retry same', or 'Dismiss'. When picked or retried, claim the park row atomically, re-run only the parked lane/target with a one-shot override, merge with sibling targets' kept outcomes, and run normal aggregation. When dismissed, commit a failed verdict via `commitGateOutcome` opening its own stage run with a new `usage-limit-dismissed` recovery trigger. For classify/op parks (no stage block), offer the same actions on the error notification to re-run or dismiss the op.

**Architecture:**
- **Store & Claim:** Conditional `claimUsageLimitPark(store, parkId, resolution, at)` inside a transaction: updates `usage_limit_parks` setting `resolved_at` and `resolution` only if `resolved_at IS NULL RETURNING *`. For stage blocks, pre-reads the stage row and aborts unless `blocked_kind = 'usage-limit'`. Clears the stage block via `setStage` (or clears block during claim). Claim happens BEFORE the adapter is built; zero rows returned aborts as already handled.
- **Model Picker:** QuickPick helpers built from `agentSwitchCoreChoices` and `agentSwitchModelChoices`, tagging the parked core/model with `(usage limit)`.
- **One-Shot Override:** Adapter is built on the fly for that run only (`overrideAdapter(provider, model)`). Settings, ticket, and role configuration remain completely untouched.
- **Re-run & Merge:** For `review`, re-runs the parked target through `runFindingsLane` (or review lane), merges with `kept_outcome` (JSON of sibling target outcomes), and aggregates. For `uat`, re-runs the target through `runUatTester`, merges with sibling observations, and aggregates. For ops (classify/intent/codePointers/suggest/improve), re-runs the specific op.
- **Dismiss:** For stage blocks, creates its own stage run via `openStageRun`, builds a `RecoveryTrigger` with `triggerKind: 'usage-limit-dismissed'`, `sourceProcessRunId: null`, and calls `commitGateOutcome` with a failed verdict, routing the result through driver/driveTicket branching. For op parks, simply resolves the park row as `'dismissed'`.
- **UI:** Blocked banner in dashboard (`stateTypes.ts`, `webview.html`) renders 'Pick agent/model…', 'Retry same', and 'Dismiss' for `usage-limit` blocks. Blocked notification (`BLOCKS_NOTIFY_PARENT`) and error notification for classify ops offer the same actions.
  - **Rule deviation (accepted 2026-10-23):** both surfaces are vanilla views, which `ui:REACT-VIEWS` otherwise keeps bug-fix-only. The ticket owner accepted the deviation because a `usage-limit` block is non-resumable and no other surface reaches the action; see the recorded exception in `docs/ui/UI-INVARIANTS.md`. It expires with each view's migration.

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest, in-memory SQLite (`openStore(':memory:')`), better-sqlite3.

**Spec:** Ticket `FEAT-USAGE-LIMIT-PARK-OFFERS` (prompt + context brief, D159).

---

### Task 1: Store Claim Transaction (`claimUsageLimitPark`)

**Files:**
- Modify: `src/store/usageLimitParks.ts`
- Test: `src/store/usageLimitParks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClaimParkResult {
    claimed: boolean;
    park: UsageLimitParkRow | null;
  }
  export function claimUsageLimitPark(
    store: Store,
    parkId: number,
    resolution: string,
    at?: string,
  ): ClaimParkResult;
  ```
- Behavior:
  Inside a transaction:
  1. Executes `UPDATE usage_limit_parks SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL RETURNING *`.
  2. If 0 rows updated, returns `{ claimed: false, park: null }`.
  3. If kind is `'stage-block'`, checks the stage row (`SELECT blocked_kind FROM stages WHERE ticket_id = ? AND stage_key = ?`). If `blocked_kind !== 'usage-limit'`, rollback/abort, returning `{ claimed: false, park: null }`.
  4. If kind is `'stage-block'`, clears the stage block via `setStage(store, ticketId, stage, { blockedKind: null, blockedReason: null, blockedAt: null })` (or `clearStageBlock`). Since the park row is already resolved in step 1, `setStage`'s D158 clear seam is a no-op.
  5. Returns `{ claimed: true, park: rowToPark(updatedRow) }`.

- [ ] **Step 1** Write unit tests in `src/store/usageLimitParks.test.ts`:
  - Successfully claims an open stage-block park and clears the stage block.
  - Aborts claim if `resolved_at` is already set (concurrent claim).
  - Aborts claim if the stage block is no longer `'usage-limit'` (e.g. replaced by retryGate or cleared by sendBack).
  - Successfully claims an open op park (no stage block check needed beyond resolved_at).
- [ ] **Step 2** Run `npx vitest run src/store/usageLimitParks.test.ts` — expect FAIL.
- [ ] **Step 3** Implement `claimUsageLimitPark` in `src/store/usageLimitParks.ts`.
- [ ] **Step 4** Run `npx vitest run src/store/usageLimitParks.test.ts` — expect PASS.
- [ ] **Step 5** Commit changes: `git commit -m "feat(store): atomic claim transaction for usage-limit parks"`

---

### Task 2: Schema / Recovery Trigger Kind (`usage-limit-dismissed`)

**Files:**
- Modify: `src/store/recoveryRoundsRead.ts` (`RecoveryTriggerKind` union, `TRIGGER_KINDS` array)
- Modify: `src/store/schema.sql` (line 330 comment documenting trigger_kind values)
- Modify: `src/model/inside/recovery.ts` (`triggerProse` for `'usage-limit-dismissed'`)
- Modify: `docs/arch/stages-and-gates.md` (or store-and-schema documentation)
- Test: `src/store/recoveryRounds.test.ts`, `src/model/inside/recovery.test.ts`

**Interfaces:**
- Produces:
  `RecoveryTriggerKind` includes `'usage-limit-dismissed'`.
  `TRIGGER_KINDS` array includes `'usage-limit-dismissed'`.
  `triggerProse` handles `'usage-limit-dismissed'` returning e.g. `'Usage limit dismissed'` or collapsed detail.

- [ ] **Step 1** Write failing tests asserting `'usage-limit-dismissed'` can be opened in a recovery round and read back without degrading to `'gate-failure'`, and that `triggerProse` formats it.
- [ ] **Step 2** Run `npx vitest run src/store/recoveryRounds.test.ts` — expect FAIL.
- [ ] **Step 3** Add `'usage-limit-dismissed'` to `RecoveryTriggerKind` and `TRIGGER_KINDS` in `src/store/recoveryRoundsRead.ts`, update `schema.sql` comment, update `triggerProse` in `src/model/inside/recovery.ts`.
- [ ] **Step 4** Run `npx vitest run src/store/recoveryRounds.test.ts` and `src/model/inside/recovery.test.ts` — expect PASS.
- [ ] **Step 5** Commit changes: `git commit -m "feat(store): add usage-limit-dismissed recovery trigger kind"`

---

### Task 3: One-Shot Override & Re-run Logic (Review & UAT Merge)

**Files:**
- Create: `src/workflow/usageLimitRerun.ts`
- Test: `src/workflow/usageLimitRerun.test.ts`
- Modify: `src/workflow/review/findingsLane.ts` (export single-target or re-run helper if needed)
- Modify: `src/workflow/uat/tester.ts` (export single-target or re-run helper if needed)

**Interfaces:**
- Produces:
  ```ts
  export interface RerunParkOptions {
    store: Store;
    parkRow: UsageLimitParkRow;
    provider: string;
    model: string | null;
    adapter: AgentAdapter;
    manifest?: Manifest;
    cwd: string;
    artifactDir: string;
    signal?: AbortSignal;
    now?: () => string;
    debug?: (m: string) => void;
  }

  export async function rerunParkedStage(opts: RerunParkOptions): Promise<StageRunResult>;
  ```
- Behavior:
  - For `review` lane:
    Re-runs the parked target with the override adapter/model.
    Merges newly discovered findings with sibling findings preserved in `parkRow.keptOutcome`.
    Runs `aggregateReview`.
    Calls `finish` / `commitGateOutcome`.
  - For `uat` lane:
    Re-runs the parked target with the override adapter/model.
    Merges newly discovered observations with sibling observations in `parkRow.keptOutcome`.
    Runs verifier / observation threshold checks / `aggregateUat`.
    Calls `finish` / `commitGateOutcome`.

- [ ] **Step 1** Write failing tests in `src/workflow/usageLimitRerun.test.ts` verifying re-running a parked review or UAT target combines with kept outcome and advances or fails the stage.
- [ ] **Step 2** Implement re-run and merge helpers.
- [ ] **Step 3** Run `npx vitest run src/workflow/usageLimitRerun.test.ts` — expect PASS.
- [ ] **Step 4** Commit changes: `git commit -m "feat(workflow): re-run parked target and merge with kept outcome"`

---

### Task 4: Dismiss Park Action (`dismissUsageLimitPark`)

**Files:**
- Modify: `src/workflow/usageLimitRerun.ts` (or `src/workflow/usageLimitDismiss.ts`)
- Test: `src/workflow/usageLimitRerun.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function dismissUsageLimitPark(
    store: Store,
    park: UsageLimitParkRow,
    opts: {
      manifest?: Manifest;
      now?: () => string;
      debug?: (m: string) => void;
    },
  ): StageRunResult;
  ```
- Behavior:
  - For `op` parks:
    No stage block. The claim already resolved the park row as `'dismissed'`. Returns `{ kind: 'stopped' }`.
  - For `stage-block` parks:
    1. Opens its OWN new stage run via `openStageRun(store, { ticketId, stageKey, attempt, runAt, startedAt })`. (Does NOT reuse `park.stageRunId`!).
    2. Constructs `recoveryTrigger`:
       - `sourceProcessId`: `park.lane === 'uat' ? 'tester' : 'review'` (or parked lane process).
       - `sourceStageRunId`: the newly opened stage run id.
       - `sourceProcessRunId`: `null`.
       - `triggerKind`: `'usage-limit-dismissed'`.
       - `triggerDetail`: `park.detail`.
       - `maxRounds`: `capForGate(stageKey, manifest?.uat?.maxFixAttempts, manifest?.review?.maxFixAttempts)`.
    3. Calls `commitGateOutcome(store, { ticketId, stageKey, runAt, gates: [], outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: park.detail } }, recoveryTrigger, stageRunId: newStageRunId })`.
    4. Routes the resulting `StageRunResult` back to caller.

- [ ] **Step 1** Write failing tests for dismissing a stage-block park: opens new run, records failed verdict and recovery round with triggerKind `usage-limit-dismissed`, `sourceProcessRunId: null`, parked run not re-closed.
- [ ] **Step 2** Implement `dismissUsageLimitPark`.
- [ ] **Step 3** Run tests — expect PASS.
- [ ] **Step 4** Commit changes: `git commit -m "feat(workflow): dismiss usage-limit park into failed verdict and recovery round"`

---

### Task 5: Extension Ops & Picker (`usageLimitParkOps`)

**Files:**
- Create: `src/extension/ops/usageLimitParkOps.ts`
- Test: `src/extension/ops/usageLimitParkOps.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CoreModelPick {
    provider: AgentProvider;
    model: string | null;
  }

  export function formatCoreChoices(parkedProvider: string): QuickPickItem[];
  export function formatModelChoices(provider: AgentProvider, catalog: ModelCatalog, parkedModel: string | null): QuickPickItem[];
  ```
- Features:
  - Labels the currently parked provider/model with `(usage limit)`.
  - Manages atomic claim and checks: if claim returns `claimed: false`, notifies user with `'already handled'` and returns.
  - Handles 'Pick agent/model…', 'Retry same', and 'Dismiss'.
  - Invokes one-shot re-run or dismiss.

- [ ] **Step 1** Write unit tests in `src/extension/ops/usageLimitParkOps.test.ts` for choices formatting, claim-then-rerun, concurrent claim abort, and dismiss.
- [ ] **Step 2** Implement `src/extension/ops/usageLimitParkOps.ts`.
- [ ] **Step 3** Run tests — expect PASS.
- [ ] **Step 4** Commit changes: `git commit -m "feat(ops): usage-limit park quickpick and resolution operations"`

---

### Task 6: UI Dashboard Blocked Banner Actions

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/messages.ts` (new message types for usage-limit park actions: `usage-limit-pick`, `usage-limit-retry`, `usage-limit-dismiss`)
- Modify: `src/ui/dashboard/webviewSend.ts`
- Test: `src/ui/dashboard/webview.test.ts`, `src/ui/dashboard/messages.test.ts`

**Interfaces & UI:**
- In `webview.html`:
  When `usageLimit` is true, render buttons:
  - `<button type="button" class="k-btn k-btn--primary k-btn--sm" data-act="usage-limit-pick" data-stagekey="...">Pick agent/model…</button>`
  - `<button type="button" class="k-btn k-btn--secondary k-btn--sm" data-act="usage-limit-retry" data-stagekey="...">Retry same</button>`
  - `<button type="button" class="k-btn k-btn--secondary k-btn--sm" data-act="usage-limit-dismiss" data-stagekey="...">Dismiss</button>`
- In `messages.ts`:
  Route actions:
  - `usage-limit-pick`: `{ type: 'usage-limit-pick', ticketId: number, stageKey: StageKey }`
  - `usage-limit-retry`: `{ type: 'usage-limit-retry', ticketId: number, stageKey: StageKey }`
  - `usage-limit-dismiss`: `{ type: 'usage-limit-dismiss', ticketId: number, stageKey: StageKey }`

- [ ] **Step 1** Write failing tests in `src/ui/dashboard/webview.test.ts` and `src/ui/dashboard/messages.test.ts`.
- [ ] **Step 2** Update `webview.html`, `messages.ts`, and `webviewSend.ts`.
- [ ] **Step 3** Run tests — expect PASS.
- [ ] **Step 4** Commit changes: `git commit -m "feat(ui): add Pick agent/model, Retry same, and Dismiss actions to blocked banner"`

---

### Task 7: Host Seam & Notification Actions Wiring

**Files:**
- Modify: `src/extension.ts` (wiring messages to `usageLimitParkOps`, keeping line count under `MAX_EXTENSION_LINES`)
- Modify: `src/extension/ops/ratchet.test.ts` (if needed, within line count bounds)
- Modify: Blocker notification handlers / classify error notification actions
- Test: `src/extensionActivation.test.ts` or integration tests

- [ ] **Step 1** Wire `usage-limit-pick`, `usage-limit-retry`, and `usage-limit-dismiss` in `extension.ts` to `usageLimitParkOps`.
- [ ] **Step 2** Add QuickPick and notification actions to classify op error notifications.
- [ ] **Step 3** Verify line count in `src/extension.ts` does not exceed `MAX_EXTENSION_LINES`.
- [ ] **Step 4** Test via integration / unit tests.
- [ ] **Step 5** Commit changes: `git commit -m "feat(extension): wire usage-limit park actions to dashboard and notifications"`

---

### Task 8: Documentation Updates

**Files:**
- Modify: `docs/arch/stages-and-gates.md`
- Modify: `docs/arch/store-and-schema.md`
- Modify: `docs/arch/agent-cores.md`

- [ ] **Step 1** Update documentation blocks with D159 details (atomic claim transaction, one-shot override, re-run & merge, usage-limit-dismissed recovery trigger).
- [ ] **Step 2** Run `npm run -s docs:check`.
- [ ] **Step 3** Commit changes: `git commit -m "docs: document usage-limit park offers and one-shot re-run (D159)"`

---

### Task 9: Full Verification Gate

- [ ] `npm run -s typecheck`
- [ ] `npx vitest run src/store/usageLimitParks.test.ts`
- [ ] `npx vitest run src/workflow/usageLimitRerun.test.ts`
- [ ] `npx vitest run src/ui/dashboard/webview.test.ts`
- [ ] `npm run -s test:unit`
- [ ] `npm run -s lint:react`
- [ ] If `src/extension/**` modified: check Stryker score `npx stryker run --mutate <changed files>` + `node scripts/mutationSummary.mjs` (keep >= 85).
- [ ] Record done marker via karst CLI.
