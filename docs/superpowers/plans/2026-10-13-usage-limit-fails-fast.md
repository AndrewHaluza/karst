# Usage/quota limit fails fast + park Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A provider quota/usage exhaustion is a typed `UsageLimitError` that `resilientAdapter` never retries nor hops; review/UAT park `blocked:usage-limit` and every other AI op records a re-runnable op park row (D159 reads the rows).

**Architecture:** A quota-only regex + typed error in `agent/cliFailure.ts` feeds `classifyFailure`'s new `usage-limited` class (checked before the rate-limit rule); `resilientAdapter` rethrows it at once. A new `BlockerKind 'usage-limit'` uses the existing block plumbing (`setStage`/`parkGateStage`). A new `usage_limit_parks` side table is written inside `parkGateStage` (stage blocks) or by a small op helper (op parks) and cleared inside `setStage`'s savepoint whenever a stage leaves the block.

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest, in-memory SQLite (`openStore(':memory:')`), better-sqlite3.

**Spec:** ticket `FIX-USAGE-QUOTA-LIMIT-FAILS-FAST` (prompt + context brief, `karst context FIX-USAGE-QUOTA-LIMIT-FAILS-FAST`).

## Global Constraints

- `describeHeadlessFailure` / `isUsageLimitFailure` text and their existing callers' semantics stay unchanged; the only adapter change is the wrapping `new Error(describeHeadlessFailure(...))` → `headlessFailureError(...)`.
- Classification stays message/text-based (K1); precedence fixed; `usage-limited` is checked BEFORE the rate-limit rule so a quota phrase never reads `transient`.
- Bare `429` / `rate limit` / `too many requests` with NO quota phrase stay `transient`.
- `usage-limited` rethrows at once: no same-model retry, no chain advance, no `notify`.
- Park = status + `stages.blocked_*` written via `setStage` (`@arch:SINGLE-WRITER`). No new `StageStatus`.
- `setStage` remains the single writer: it now also resolves an open `usage_limit_parks` row inside its `stage_write` savepoint.
- New timestamps are caller-supplied ISO strings where the caller holds a clock (every park writer passes `parkedAt`/`runAt`); the one store-side default — `setStage`'s park resolve — is centralised in `nowIso()` and overridable via `SetStageOptions.parkResolvedAt` so a test can pin `resolved_at`.
- New schema: `schema.sql` (fresh DBs) + guarded migration + `SCHEMA_VERSION` bump + `db.integration.test.ts` update (`@arch:SCHEMA-CHECK`).
- Files small (<400 lines typical). Commands: `npx vitest run <file>`, `npm run -s typecheck`. Never `--reporter`.

---

### Task 1: Typed `UsageLimitError` + quota-only classifier (cliFailure)

**Files:**
- Modify: `src/agent/cliFailure.ts` (`HeadlessFailure` ~:40, `analyze` ~:144, add `QUOTA_PHRASES` near `LIMIT_PHRASES` :37)
- Test: `src/agent/cliFailure.test.ts`

**Interfaces:**
- Produces: `QUOTA_PHRASES: RegExp`; `isQuotaExhausted(failure: HeadlessFailure): boolean`; `class UsageLimitError extends Error` with readonly `tool`, `provider`, `model`, `status`, `detail`; `headlessFailureError(failure: HeadlessFailure): Error`. `HeadlessFailure` gains optional `provider?: string; model?: string`.

- [ ] **Step 1** Write failing tests: quota phrases → `isQuotaExhausted` true / `headlessFailureError` returns a `UsageLimitError` carrying tool/provider/model/status/detail and the `describeHeadlessFailure` sentence; bare 429 ("429 Too Many Requests") → not quota, plain `Error`; non-quota failure → plain `Error` with the unchanged describer text.
- [ ] **Step 2** Run `npx vitest run src/agent/cliFailure.test.ts` — expect FAIL (exports missing).
- [ ] **Step 3** Implement: `QUOTA_PHRASES = /(quota[-_ ]?exceeded|usage limit|spend limit|limit reached|out of credits?|insufficient[_ ]quota|resource[-_ ]?exhausted)/i`; `Analysis.quota`; `isQuotaExhausted`; the error class + builder.
- [ ] **Step 4** Run the file — PASS.
- [ ] **Step 5** Commit.

### Task 2: `usage-limited` FailureClass + resilientAdapter no-retry

**Files:**
- Modify: `src/agent/failureClass.ts` (`FailureClass` :13, new rule before :102), `src/agent/resilientAdapter.ts` (:147)
- Test: `src/agent/failureClass.test.ts`, `src/agent/resilientAdapter.test.ts`

**Interfaces:**
- Consumes: `QUOTA_PHRASES`, `UsageLimitError` (Task 1).
- Produces: `FailureClass` includes `'usage-limited'`; `resilientAdapter` rethrows `usage-limited` immediately.

- [ ] **Step 1** failing tests: classify (a) a `UsageLimitError` instance → `usage-limited`; (b) `insufficient_quota` text → `usage-limited`; (c) `429 Too Many Requests` → `transient`; (d) `rate limit exceeded` → `transient`. Update the old K5 "usage limit ... (HTTP 429)" case to `usage-limited`. resilientAdapter: a `UsageLimitError` thrown by the inner adapter is rethrown with exactly ONE inner call and no `notify`.
- [ ] **Step 2** run both files — FAIL.
- [ ] **Step 3** implement.
- [ ] **Step 4** run — PASS.
- [ ] **Step 5** commit.

### Task 3: Route every adapter's failure through `headlessFailureError`

**Files:**
- Modify: `src/agent/claude.ts` (~:696), `codex.ts` (~:775), `opencode.ts` (~:1405), `opencode2.ts` (~:598), `antigravity.ts` (~:509)
- Test: `src/agent/adapterConformance.test.ts` (extend @:439-ish), `src/agent/instrumentedAdapter.test.ts`

**Interfaces:**
- Consumes: `headlessFailureError` (Task 1).
- Produces: each adapter passes `provider` and `model: opts.model` (opencode2 keeps `OPENCODE2_TOOL_LABEL`) and throws `headlessFailureError({...})` (inside `attachUsage`).

- [ ] **Step 1** failing conformance test: spawn a quota-exhausted run (exit 1, stdout `{"result":"insufficient_quota"}`, or stderr `insufficient_quota`) for every provider and assert the rejection is `instanceof UsageLimitError` with `tool`/`provider` set. Instrumented-adapter test: the thrown `UsageLimitError` passes through `instrumentAdapter` with its class identity intact.
- [ ] **Step 2** run — FAIL.
- [ ] **Step 3** implement the five call sites.
- [ ] **Step 4** run — PASS.
- [ ] **Step 5** commit.

### Task 4: `BlockerKind 'usage-limit'` + Needs-you + Resume refusal

**Files:**
- Modify: `src/model/types.ts` (:80 union), `src/model/blockerNotify.ts` (:13 record), `src/cli/test/setStage.ts` (:26 array), `src/model/ticketGlyph.ts` (:88), `src/model/stepper.ts` (:109), `src/workflow/stageResume.ts` (:54)
- Test: `src/model/blockerNotify.test.ts` (if present), `src/cli/test/setStage.test.ts`, `src/model/ticketGlyph.test.ts`, `src/workflow/stageResume.test.ts`

**Interfaces:**
- Produces: `BlockerKind` includes `'usage-limit'`; reason text `usage limit — <tool> <model>`; `needsUser` true; `StepperCell.blocked.resumable` false; `resumeBlockedStage` refuses.

- [ ] **Step 1** failing tests: notify record has `'usage-limit': true`; `parseSetStageArgs(['--stage','uat','--status','failed','--block','usage-limit','--block-reason','x'])` accepts; `needsUser` true for a `usage-limit` block; `blockedDetail` resumable false; `resumeBlockedStage` returns `{kind:'refused'}` and leaves the block.
- [ ] **Step 2/3/4** run→implement→pass.
- [ ] **Step 5** commit.

### Task 5: `usage_limit_parks` table + migration + write/clear seams

**Files:**
- Create: `src/store/usageLimitParks.ts` (`USAGE_LIMIT_PARKS_DDL`, types, `insertOpenPark`, `resolveOpenParks`)
- Modify: `src/store/schema.sql`, `src/store/migrations.ts` (v82), `src/store/schemaVersion.ts` (82), `src/store/stageBlocks.ts` (`ParkGateStageInput.park`, insert in txn), `src/store/stages.ts` (`SetStageOptions.parkResolution`, resolve inside savepoint)
- Test: `src/store/usageLimitParks.test.ts`, `src/store/db.integration.test.ts`, `src/store/schemaMerge.test.ts` (only if it asserts a count)

**Interfaces:**
- Produces: `USAGE_LIMIT_PARKS_DDL`; `UsageLimitParkKind = 'stage-block'|'op'|'interactive'`; `insertOpenPark(store, input)`; `resolveOpenParks(store, {ticketId, stage, resolution, at})`; `listOpenParks(store, ticketId)`. `ParkGateStageInput.park?: UsageLimitParkInput`; `SetStageOptions.parkResolution?: string` (default `'cleared'`).

- [ ] **Step 1** failing tests: fresh DB has the table + both indexes; v81→82 migration adds them; opening two identical keys keeps ONE open row (upsert); `parkGateStage` with `kind:'usage-limit'` + `park` writes one open row in the same txn; `clearStageBlock` resolves it; a `setStage` that overwrites `blockedKind` (e.g. another kind) also resolves it; a non-usage-limit park writes none.
- [ ] **Step 2/3/4** run→implement→pass.
- [ ] **Step 5** commit.

### Task 6: Review — findings lane `usage-limited` outcome + R-rule before R5

**Files:**
- Modify: `src/workflow/review/findingsLane.ts` (throw path ~:460), `src/workflow/review/aggregate.ts` (new rule before R5)
- Test: `src/workflow/review/findingsLane.test.ts`, `src/workflow/review/aggregate.test.ts`

**Interfaces:**
- Produces: `FindingsLaneOutcome` gains `{ kind:'usage-limited'; target: string; provider: string; model: string|null; detail: string; keptOutcome: string|null }`; `AggregateOutcome`'s blocked variant gains optional `park` (`{provider,model,lane,target,detail,keptOutcome}`); the rule returns `blocked:usage-limit` before R5/R6/R6b.

- [ ] **Step 1** failing tests: a target whose `runHeadless` rejects with `UsageLimitError` yields the lane outcome; `aggregateReview` with one quota-dead target + one target with findings → `{kind:'blocked', blocker:'usage-limit'}` (not pass/fail).
- [ ] **Step 2/3/4** → pass.
- [ ] **Step 5** commit.

### Task 7: Review stage — pass the park through to `commitGateOutcome`

**Files:**
- Modify: `src/workflow/stages/review.ts` (finish/aggregate call), `src/workflow/gates/commit.ts` (`RunOutcome.blocked` gains `park?`; the blocked branch passes `park: outcome.park`)
- Test: `src/workflow/gates/commit.test.ts`, `src/workflow/stages/review.test.ts`

- [ ] **Step 1** failing test: driven through `commitGateOutcome` with a blocked/usage-limit outcome carrying `park`, one open `usage_limit_parks` row exists (not only via `parkGateStage`).
- [ ] **Step 2/3/4** → pass.
- [ ] **Step 5** commit.

### Task 8: UAT — tester `usage-limited` outcome + aggregate rule

**Files:**
- Modify: `src/workflow/uat/tester.ts` (inner catch ~:891 and outer ~:1107), `src/workflow/uat/aggregate.ts`
- Test: `src/workflow/uat/tester.test.ts`, `src/workflow/uat/aggregate.test.ts`

**Interfaces:**
- Produces: `RunUatTesterResult` gains `{ kind:'usage-limited'; target; provider; model; detail; keptOutcome }`; `aggregateUat` returns `blocked:usage-limit` before the pass rules.

- [ ] **Step 1** failing tests: a quota-dead target is NOT folded into `execution-failed` nor `partial`; a sibling with observations is kept; the stage parks `blocked:usage-limit`.
- [ ] **Step 2/3/4** → pass.
- [ ] **Step 5** commit.

### Task 9: UAT stage — pass the park through

**Files:** `src/workflow/stages/uat.ts`, `src/workflow/gates/commit.ts` (already from Task 7)
- Test: `src/workflow/stages/uat.test.ts`

- [ ] **Step 1** failing test: a quota-dead Tester run parks the stage `usage-limit` and writes the park row; no fix attempt consumed.
- [ ] **Step 2/3/4** → pass.
- [ ] **Step 5** commit.

### Task 10: Op parks for non-stage AI ops

**Files (exactly what the diff changes):**
- Modify: `src/workflow/stages/fix.ts`, `src/workflow/stages/shipDescription.ts`, `src/workflow/artifacts/alignment.ts` (catch → `recordUsageLimitOpPark` / `onUsageLimit`); `src/workflow/classify/runAnalysis.ts` (threads `onUsageLimit` to every pass and calls it from the `classify`/`improve` catches); `src/workflow/classify/intent.ts` and `src/workflow/classify/codePointers.ts` (own catch → `onUsageLimit`); caller seams `src/extension/alignmentBinding.ts` and `src/ui/ticketForm/actions.ts` (own the store, so they write the park row).
- Create: `src/store/usageLimitParks.ts` — `recordUsageLimitOpPark(store, error, input)` (Task 5 file).
- **No edit needed** in `classify/improve.ts` or `classify/suggest.ts`: `improve` is wrapped by `runAnalysis` (which calls `onUsageLimit`), and `suggest` is caught by `actions.ts`'s `suggestSignals`. Both write one open `op` row (stage set, lane NULL).
- Test: one test per seam (fix, PR description, alignment, runAnalysis→improve, ticketForm→suggest) that a `UsageLimitError` writes one open `op` park row and the op still fails as today.

- [ ] **Step 1** failing test.
- [ ] **Step 2/3/4** → pass.
- [ ] **Step 5** commit.

### Task 11: Docs + dashboard labels

**Files:**
- Modify: `docs/arch/agent-cores.md` (`arch:AC-13` table + K11 row + `arch:AC-06` if it names classes), `docs/arch/stages-and-gates.md` (`arch:SINGLE-WRITER` + stageResume header note + a park note), `docs/arch/store-and-schema.md` (new `arch:V82` block), `src/ui/dashboard/stateTypes.ts` / `webview.html` (usage-limit banner label / no Resume).
- Test: `src/workflow/stageResume.test.ts` doc-pin if one exists.

- [ ] **Step 1** doc edits + banner wording.
- [ ] **Step 2** run `npx vitest run` on touched UI/state tests → pass.
- [ ] **Step 3** commit.

### Task 12: Full verification

- [ ] `npm run -s typecheck`
- [ ] `npx vitest related <all changed files>` then `npm run -s test:unit`
- [ ] `npm run -s lint:react` (no React change expected, cheap)
- [ ] If anything under `src/extension/**` changed: `npx stryker run --mutate <changed extension files>` + `node scripts/mutationSummary.mjs`, keep ≥85.

## Self-Review

- Spec §1 → Task 1,3. §2 → Task 2. §3 → Task 2. §4 → Task 4. §4b → Task 4. §5 (review/UAT) → Tasks 6-9; (other ops) → Task 10. §6 → Tasks 5,7,9,10. TESTS list → distributed across Tasks 1-11.
- No placeholders: every task names exact files + the observable assertion.
- Type consistency: `UsageLimitError` fields, `FindingsLaneOutcome['usage-limited']`, `RunOutcome.blocked.park`, `ParkGateStageInput.park` and `SetStageOptions.parkResolution` are defined in Tasks 1/5 and reused unchanged.
