# Inside Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a truthful, evidence-backed six-stage Inside component with causal recovery, per-process AI identity/tokens, persistent Ship provenance, and a Done delivery receipt.

**Architecture:** Preserve the runtime stage machine, including its internal `fix` node, and introduce a separate six-stage presentation model built by pure host reducers. Add durable process/run evidence before exposing new facts, write evidence as each operation happens, and keep the standalone webview presentation-only with local selection/disclosure state.

**Tech Stack:** TypeScript 7, Vitest 4, SQLite/better-sqlite3, VS Code webviews with injected Karst design-system CSS/JS, Node ESM.

## Global Constraints

- Runtime lifecycle remains `scope → impl → uat/review → fix when needed → ship → done`; `fix` is projected into Inside UAT/Review, not removed from storage or the graph.
- Done remains an entry condition reached only after every current PR is literally `merged`; unknown PR state is unmerged.
- Verdicts remain deterministic. AI prose and AI-authored structured output never transition the machine. UAT Tester observations require a separate host-run verifier exit code before they can affect progression or recovery; existing Review behavior is recorded explicitly but is not widened into a new verdict seam.
- Evidence is written when it happens. Process rows open before work and preserve partial results across extension-host death.
- Explicit `impl`/`fix` pass markers close their durable execution rows in the same transaction as the stage transition; lifecycle hooks never infer a pass.
- Permanent ticket deletion remains executable with foreign keys enabled: ticket-owned evidence is removed leaf-first, while global usage rows are detached and retain only unattributed counts.
- Interactive cumulative-usage baselines are scoped to provider session identity across Karst processes/segments; a new Karst process or segment is not a new counter lifetime. Count a first cumulative observation from zero only when a durable launch intent proves Karst created a newly instrumented provider session; otherwise persist it as an unattributed baseline.
- Provider capability is evidence-based. Claude Code and Antigravity interactive token usage remain unsupported until an authoritative provider event exposes numeric counters plus a stable event id; unsupported processes omit tokens rather than estimating or displaying zero.
- Settings are future configuration. Every started AI process snapshots agent name, provider, model, and recovery cap where applicable.
- Missing historical facts render as absence, never zero, pass, or reconstructed prose.
- The webview does not order processes, aggregate repositories, derive statuses, parse references, or invent navigation targets.
- Webview action messages carry only an opaque action id issued for the current ticket snapshot. The host resolves that id through a ticket-scoped allowlist; file navigation additionally re-loads the recorded evidence and proves its canonical path remains inside the recorded repository worktree before opening it.
- UI changes obey `docs/ui/UI-RULES.md`, especially UI-R01–R06, UI-R09, UI-R11–R18, and UI-R23–R32.
- No new UI framework or runtime dependency.
- Repository details are bounded to 6, findings to 6, and gate evidence to 8 before a typed continuation action.
- Every production behavior follows RED → GREEN → REFACTOR. Run focused tests after each task and full tests/typecheck/build at the final gate.

## Delivery slices

This plan is one dependency graph but should be reviewed as four releasable slices:

1. **Foundation:** Tasks 1–5 add the presentation contract, durable generic evidence, implementation segments, and measured interactive-usage ingestion without enabling unsupported UI claims.
2. **Workflow evidence:** Tasks 6–9 add recovery snapshots, Tester/Review executions, and Ship provenance.
3. **Reducers/protocol:** Tasks 10–13 create the evidence-backed views and host-owned live/action contracts.
4. **Webview/verification:** Tasks 14–16 replace the flat UI, add specialized renderers, and verify scale/accessibility.

---

### Task 1: Introduce the Six-Stage Inside Contract and Registry

**Files:**
- Modify: `src/model/inside/types.ts`
- Create: `src/model/inside/registry.ts`
- Create: `src/model/inside/registry.test.ts`
- Modify: `src/model/inside/index.test.ts`

**Interfaces:**
- Produces: `InsideStageKey`, `InsideProcessId`, `InsideProcessView`, `InsideStageView`, `ProcessEvidenceView`, `InsideActionKind`, `TypedInsideAction`, `INSIDE_PROCESSES`, `insideStageForRuntimeStage`.
- Consumes: existing runtime `StageKey`; does not modify `src/model/types.ts` or `src/workflow/graph.ts`.

- [ ] **Step 1: Write failing registry and projection tests**

```ts
expect(INSIDE_PROCESSES.ship).toEqual(['commit', 'push', 'pr', 'merge']);
expect(INSIDE_PROCESSES.done).toEqual(['delivery-receipt']);
expect(insideStageForRuntimeStage('fix', 'review')).toBe('review');
expect(insideStageForRuntimeStage('fix', 'uat')).toBe('uat');
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run src/model/inside/registry.test.ts`
Expected: FAIL because the registry and projection API do not exist.

- [ ] **Step 3: Add the rich discriminated contract**

```ts
export type InsideStageKey = 'scope' | 'impl' | 'uat' | 'review' | 'ship' | 'done';
export type InsideStatus = 'pending' | 'run' | 'wait' | 'pass' | 'fail' | 'note' | 'skip';

export interface AgentExecutionView {
  agentName?: string;
  provider: string;
  providerLabel: string;
  model: string | null;
  modelLabel: string;
}

export type InsideActionKind =
  | 'open-pr'
  | 'open-commit'
  | 'open-file'
  | 'open-stage-log'
  | 'resume-stage'
  | 'open-full-evidence';

export interface TypedInsideAction {
  actionId: string; // opaque snapshot-scoped capability; never a path, URL, repo, SHA, or PR number
  kind: InsideActionKind; // presentation hint only; the host does not trust it on dispatch
}

export interface InsideProcessView {
  id: string;
  kind: string;
  label: string;
  status: InsideStatus;
  detail?: string;
  count?: string;
  duration?: string;
  ai?: boolean;
  execution?: AgentExecutionView;
  configuredExecution?: AgentExecutionView;
  tokens?: TokenUsageView;
  evidence?: ProcessEvidenceView;
  action?: TypedInsideAction;
}
```

`ProcessEvidenceView` must be a closed union keyed by `kind` (`rows`, `gates`, `findings`, `timeline`, `commits`, `prs`, `recovery`, `receipt`), while unknown process ids use the generic `rows` renderer.

- [ ] **Step 4: Implement the registry without changing runtime stages**

```ts
export const INSIDE_PROCESSES: Readonly<Record<InsideStageKey, readonly string[]>> = {
  scope: ['hot-set', 'worktrees'],
  impl: ['session'],
  uat: ['gates', 'services', 'tester'],
  review: ['gates', 'services', 'review'],
  ship: ['commit', 'push', 'pr', 'merge'],
  done: ['delivery-receipt'],
};
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/model/inside/registry.test.ts src/model/inside/index.test.ts`
Expected: PASS.
Commit: `feat: define evidence-backed inside process contract`

### Task 2: Add Schema v26 for Durable Process Evidence

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/db.test.ts`
- Create: `src/store/processRuns.ts`
- Create: `src/store/processRuns.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extensionActivation.test.ts`

**Interfaces:**
- Produces: `openProcessRun`, `finishProcessRun`, `listProcessRuns`, `reconcileProcessRuns`, `describeStaleProcessRun`, `ProcessRun`, `ProcessRunStatus`.
- Consumes: `Store`, ticket ids, optional `stage_runs.id`, the opening host pid, and the injected `IsAlive` predicate used by activation reconciliation.

- [ ] **Step 1: Write failing migration and store tests**

Cover fresh DB creation, v25 → v26 migration, immutable identity snapshots, status transitions, ticket-scoped ordering, superseded-run reconciliation, and activation reconciliation. Pin the same conservative rules as `stage_runs`: a new run marks an older `running` row for the same ticket/stage/process stale in the opening transaction; a dead recorded pid becomes stale on activation; a live pid or null pid remains untouched; stale rows retain `ended_at = NULL`; and a late finisher cannot overwrite `stale`. The mutation each test catches is a missing table/index, an overwritten provider/model snapshot, a cross-ticket read, or a process that remains falsely `running` after its host died.

```ts
const run = openProcessRun(store, {
  ticketId,
  stageKey: 'review',
  processId: 'review',
  attempt: 1,
  stageRunId: null,
  agentName: 'Review Agent',
  provider: 'codex',
  model: 'sol',
  pid: process.pid,
  startedAt: '2026-08-08T10:00:00.000Z',
});
finishProcessRun(store, run.id, 'passed', '2026-08-08T10:01:00.000Z');
expect(listProcessRuns(store, ticketId)[0]).toMatchObject({ provider: 'codex', model: 'sol', status: 'passed' });
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/db.test.ts src/store/processRuns.test.ts`
Expected: FAIL because schema version 26 and the store module do not exist.

- [ ] **Step 3: Add the canonical table and migration**

```sql
CREATE TABLE IF NOT EXISTS process_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  stage_key     TEXT NOT NULL,
  process_id    TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  stage_run_id  INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  agent_name    TEXT,
  provider      TEXT,
  model         TEXT,
  pid           INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','passed','failed','interrupted','stale')),
  result_kind   TEXT,
  artifact_path TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_process_runs_ticket
  ON process_runs(ticket_id, stage_key, process_id, id);
```

Increment `SCHEMA_VERSION` to 26, mirror the table in both fresh schema and migration, and do not backfill historical AI identity or pids.

- [ ] **Step 4: Implement positional-parameter store APIs**

Use `store.db.prepare(sql).get/all/run` with positional `?` parameters only so the Node built-in SQLite CLI path remains compatible. Mirror `stageRuns.ts` rather than inventing a second crash policy: `openProcessRun` stales a superseded row before insert, `finishProcessRun` updates only `status = 'running'`, and `reconcileProcessRuns` globally marks only rows with a recorded dead pid stale. Register that reconciliation beside `reconcileStageRuns` in the activation sweep and report every stale run through bounded diagnostics so evidence loss is visible.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/store/db.test.ts src/store/processRuns.test.ts src/extensionActivation.test.ts`
Expected: PASS.
Commit: `feat: persist process execution evidence`

### Task 3: Link Tokens and Findings to Process Runs

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/tokenUsage.ts`
- Modify: `src/store/tokenUsage.test.ts`
- Modify: `src/store/reviewFindings.ts`
- Modify: `src/store/reviewFindings.test.ts`
- Modify: `src/store/tickets.ts`
- Modify: `src/store/tickets.test.ts`
- Modify: `src/runtime/deleteTicket.test.ts`
- Modify: `src/agent/instrumentedAdapter.ts`
- Modify: `src/agent/instrumentedAdapter.test.ts`
- Modify: `src/agent/adapter.ts`

**Interfaces:**
- Consumes: `tracking.processRunId?: number` on `runHeadless` options.
- Produces: nullable `processRunId` on token/finding evidence and `summarizeRecordedTokenUsage`, which excludes estimated rows.

- [ ] **Step 1: Write failing attribution tests**

```ts
expect(listTokenUsage(store, { ticketId, processRunId: run.id })).toHaveLength(1);
expect(summarizeRecordedTokenUsage(store, ticketId)).toEqual({ input: 120, output: 30, total: 150 });
```

Seed a second `estimated = 1` row and prove it is excluded from the recorded summary. Seed legacy null-linked rows and prove normal ticket-level queries still return them. Enable foreign keys, seed every new linked evidence shape, permanently delete the ticket, and prove deletion succeeds without leaving ticket-owned process/implementation/launch-intent/recovery/Ship rows or destroying the global token ledger.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/tokenUsage.test.ts src/store/reviewFindings.test.ts src/store/tickets.test.ts src/runtime/deleteTicket.test.ts src/agent/instrumentedAdapter.test.ts`
Expected: FAIL because process linkage, FK-safe permanent deletion, and recorded-only aggregation are absent.

- [ ] **Step 3: Add nullable linkage columns and indexes**

```sql
ALTER TABLE token_usage ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL;
ALTER TABLE review_findings ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_token_usage_process ON token_usage(process_run_id, id);
CREATE INDEX IF NOT EXISTS idx_review_findings_process ON review_findings(process_run_id, id);
```

Increment `SCHEMA_VERSION` to 27. Guard the migration with `tableColumns`; fresh schema includes the columns directly. Do not assign legacy rows to invented runs. Every later nullable attribution link to ticket-owned execution evidence must also use `ON DELETE SET NULL`; every new ticket-owned root/child (`process_runs`, implementation runs/segments/samples, Tester evidence, recovery rounds, and Ship runs/steps) uses a cascade rooted at its ticket or parent. This keeps partial cleanup FK-safe without making cascade order an implicit product contract.

Extend `src/store/tickets.ts`'s hard-delete transaction rather than relying on SQLite to discover an order. First detach the global accounting ledger with `UPDATE token_usage SET ticket_id = NULL` and clear every execution/sample attribution column present in the final schema. Then delete ticket-owned evidence leaf-first (Tester/Review findings, interactive samples, recovery rounds, session launch intents, Ship operation intents/steps/commits, gate/phase evidence, and stage/process/implementation/Ship roots), followed by the existing child tables and ticket row. Extend the hard-delete tests whenever Tasks 4–9 add a table. The final test must create every linked evidence shape, call the real `deleteTicket`/`deleteTicketPermanently` path, and prove no `SQLITE_CONSTRAINT_FOREIGNKEY`, no ticket-owned evidence rows, and a surviving token row with `ticket_id` plus all execution attribution set to `NULL`. Do not rely only on direct `DELETE FROM tickets`: `src/store/tickets.ts` is the product deletion contract.

- [ ] **Step 4: Thread the closed tracking field through the adapter seam**

```ts
tracking: {
  callSite: AiCallSite;
  ticketId?: number;
  processRunId?: number;
}
```

Record usage in the existing swallowed-write boundary so a locked DB never fails the AI operation.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/store/tokenUsage.test.ts src/store/reviewFindings.test.ts src/store/tickets.test.ts src/runtime/deleteTicket.test.ts src/agent/instrumentedAdapter.test.ts src/workflow/tokenUsageAttribution.test.ts`
Expected: PASS.
Commit: `feat: attribute recorded tokens to inside processes`

### Task 4: Add Stable Implementation Runs and Provider Segments

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/implementationRuns.ts`
- Create: `src/store/implementationRuns.test.ts`
- Create: `src/store/sessionLaunchIntents.ts`
- Create: `src/store/sessionLaunchIntents.test.ts`
- Modify: `src/store/phaseMarks.ts`
- Modify: `src/store/phaseMarks.test.ts`
- Modify: `src/agent/sessionSwitch.ts`
- Modify: `src/agent/sessionSwitch.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/ui/session.test.ts`
- Modify: `src/ui/sessionReloadIdentity.test.ts`
- Modify: `src/workflow/stages/implement.ts`
- Modify: `src/workflow/stages/implement.test.ts`
- Modify: `src/cli/stage.ts`
- Modify: `src/cli/stage.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `openImplementationRun`, `openImplementationSegment`, `confirmImplementationSegment`, `closeImplementationSegment`, `completeImplementationRun`, `interruptImplementationRun`, `listImplementationTimeline`, `recordSessionLaunchIntent`, `failSessionLaunchIntent`, `confirmSessionLaunchIntent`, and `supersedePendingLaunchIntents`.
- Consumes: every provider `SessionStart` as confirmation; a synchronous `SessionManager.onLaunchPrepared` callback records pending intent for any actual ordinary/switch launch but not for a focus/adoption no-op; `onLaunchFailed` resolves terminal-creation failures; the explicit `stage impl pass` marker is the only completion authority.

- [ ] **Step 1: Write failing same-run/multiple-segment tests**

```ts
expect(timeline.run.id).toBe(stableRunId);
expect(timeline.segments.map((s) => [s.provider, s.model])).toEqual([
  ['claude', 'opus'],
  ['codex', 'sol'],
]);
expect(timeline.segments[1]!.providerSessionId).toBe('codex-session-2');
```

Also prove that an ordinary first launch creates the first segment without any switch intent, an ordinary resume/reload reattaches the provider session to the stable run, a switch creates a later segment, focus/adoption invokes no launch callback and creates no pending intent, and legacy phase marks keep null segment linkage. Persist a launch intent, close and reopen the store, then prove only a `SessionStart` carrying the same launch id can confirm it. A second pending launch for the same ticket/purpose supersedes the first; a stale/mismatched start mutates neither intent nor timeline; terminal creation failure marks the intent `failed` and creates no segment. Fire the real `runStageCommand(..., ['stage','impl','pass'])` path and prove it closes the active segment and its Session process run, marks the stable run `passed`, stamps all end times, and advances to UAT in one transaction. A refused/stale marker must change none of them; a `SessionEnd` without the marker may interrupt a segment/process run but must never mark the implementation run passed.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/implementationRuns.test.ts src/store/sessionLaunchIntents.test.ts src/agent/sessionSwitch.test.ts src/hooks/dispatch.test.ts src/store/phaseMarks.test.ts src/ui/session.test.ts src/ui/sessionReloadIdentity.test.ts src/workflow/stages/implement.test.ts src/cli/stage.test.ts`
Expected: FAIL because stable implementation runs, segments, and explicit-marker completion wiring are absent.

- [ ] **Step 3: Add implementation run/segment schema**

```sql
CREATE TABLE IF NOT EXISTS implementation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  process_run_id INTEGER NOT NULL UNIQUE REFERENCES process_runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','passed','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS implementation_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  implementation_run_id INTEGER NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  provider_session_id TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','closed','interrupted')),
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS session_launch_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  launch_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('implementation','fix')),
  implementation_run_id INTEGER REFERENCES implementation_runs(id) ON DELETE CASCADE,
  process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  reason TEXT NOT NULL,
  session_origin TEXT NOT NULL CHECK (session_origin IN ('new','resume','unknown')),
  provider_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed','superseded')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_launch_pending
  ON session_launch_intents(ticket_id, purpose) WHERE status = 'pending';
```

Increment `SCHEMA_VERSION` to 28. Add nullable `implementation_run_id` and `implementation_segment_id` to `phase_marks`, add nullable `implementation_segment_id` to `token_usage`, and create an index on `token_usage(implementation_segment_id, id)`. Add `launch_intent_id INTEGER NOT NULL UNIQUE REFERENCES session_launch_intents(id) ON DELETE CASCADE` to `implementation_segments`, so a confirmed segment is traceable to the exact prepared launch. All nullable evidence links use `ON DELETE SET NULL`, as required by the permanent-delete contract from Task 3; legacy rows keep null links. Opening an Implementation run also opens its canonical `process_runs(stage_key='impl', process_id='session')` row and stores that id on `implementation_runs`.

- [ ] **Step 4: Record only confirmed provider sessions**

Add host-agnostic synchronous `onLaunchPrepared` and `onLaunchFailed` callbacks to `SessionManager`. `onLaunchPrepared` runs only after allocating the hook `launchId` for an actual new terminal and before `createTerminal`; existing-terminal focus and revived-terminal adoption returns invoke neither callback. The `karst.openSession` command supplies the resolved provider/model and persists the full `session_launch_intents` row, including launch id, stable Implementation run, Session process run, reason (`initial | resume | switch`), and whether the adapter command creates a new provider session or resumes one. Wrap terminal creation so a synchronous creation failure calls `onLaunchFailed(launchId)`; starting a newer launch transactionally marks the older pending intent for that ticket/purpose `superseded`. The row stays pending because terminal creation is not proof the provider started.

`hooks/dispatch.ts` resolves every accepted `SessionStart` by the URL-authenticated launch id, then verifies ticket, pending status, provider, and current lifecycle generation before mutating anything. In one transaction it stores the provider session id on the intent and confirms the corresponding segment. For an ordinary first launch it confirms the first segment; for a resume/reload it reattaches the provider session to the compatible segment or confirms a resume segment according to the stored intent; for a switch it confirms the new segment and closes the previous one while preserving the stable Karst run id. An unknown, failed, superseded, already-consumed, or mismatched launch id is rejected by the existing lifecycle barrier. Never recover intent from in-memory callback state after reload, require a switch record for an initial segment, or pretend provider session ids are shared across cores.

Route the parsed `impl` marker in `src/cli/stage.ts` through `markImplementDone`, not directly through the generic four-argument transition. `markImplementDone` calls `transition(..., premutate)` and uses that same transaction to `completeImplementationRun`: close the current confirmed segment, mark the stable run `passed`, and record its end time. Keep `parseStageArgs`'s narrow security boundary unchanged. The marker remains the only completion signal; `SessionEnd`/terminal close can call `interruptImplementationRun` only when the host has evidence of interruption and can never synthesize a passed run. This gives every opened implementation run a durable terminal path without weakening the explicit-marker invariant.

- [ ] **Step 5: Keep Implementation tokens absent**

Do not synthesize token values for interactive sessions in this task. Add a reducer test asserting that a segment without measured usage omits `tokens` rather than returning total `0`; Task 5 adds the measured ingestion seam.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/store/implementationRuns.test.ts src/store/sessionLaunchIntents.test.ts src/agent/sessionSwitch.test.ts src/hooks/dispatch.test.ts src/store/phaseMarks.test.ts src/ui/session.test.ts src/ui/sessionReloadIdentity.test.ts src/workflow/stages/implement.test.ts src/cli/stage.test.ts`
Expected: PASS.
Commit: `feat: preserve implementation agent switch history`

### Task 5: Ingest Measured Interactive Token Deltas

**Files:**
- Create: `src/agent/interactiveUsage.ts`
- Create: `src/agent/interactiveUsage.test.ts`
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/db.test.ts`
- Create: `src/store/interactiveUsageSamples.ts`
- Create: `src/store/interactiveUsageSamples.test.ts`
- Modify: `src/agent/aiCallSites.ts`
- Modify: `src/agent/settings.test.ts`
- Modify: `src/agent/codex.ts`
- Modify: `src/agent/codex.test.ts`
- Modify: `src/agent/opencode.ts`
- Modify: `src/agent/opencode.test.ts`
- Modify: `src/agent/antigravity.test.ts`
- Modify: `src/hooks/endpoint.ts`
- Modify: `src/hooks/endpoint.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/store/tokenUsage.ts`
- Modify: `src/store/tokenUsage.test.ts`
- Modify: `src/agent/provider.ts`

**Interfaces:**
- Produces: `InteractiveUsageSample`, `appendInteractiveUsageSample`, `lastInteractiveUsageSample`, `interactiveUsageDelta`, and closed `UsageUpdate` hook handling owned by `process_run_id` with optional `implementation_segment_id` refinement.
- Consumes: provider-reported numeric cumulative usage plus a stable provider event id; the confirmed session binding and durable launch intent determine process ownership and whether the first observation is billable or baseline-only.

- [ ] **Step 1: Write failing delta and validation tests**

```ts
expect(interactiveUsageDelta(
  { input: 1_000, output: 200, cacheRead: 100, cacheWrite: 20, total: 1_320 },
  { input: 1_450, output: 320, cacheRead: 180, cacheWrite: 40, total: 1_990 },
)).toEqual({ input: 450, output: 120, cacheRead: 80, cacheWrite: 20, total: 670 });
```

Cover first sample, repeated cumulative sample, negative/reset counters, distinct cache-read/cache-write counts, provider totals, non-numeric fields, wrong provider/session, stale process ownership, optional Implementation segment attribution, Fix process attribution, and duplicate event id. A first sample starts from implicit zero only when its confirmed `session_launch_intents.session_origin='new'` proves Karst created that provider session under instrumentation. For a resumed/adopted/pre-v29 provider session with no prior sample, persist the observation as `baseline_only=1` and write no `token_usage` row; the next observation subtracts that baseline. Close and reopen the store between samples to prove the decision is durable. Then close one Karst segment/process, resume the **same provider session id** into a later Implementation segment and into a Fix process, and prove each later sample subtracts the provider session's last persisted cumulative sample while attributing only its delta to the currently bound process. When any counter decreases during a confirmed continuously instrumented session, open a new provider-session counter epoch and write that reset sample's full non-negative counts; if continuity cannot be proved, treat the reset sample as a new unattributed baseline.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/agent/interactiveUsage.test.ts src/store/interactiveUsageSamples.test.ts src/hooks/endpoint.test.ts src/hooks/dispatch.test.ts src/store/tokenUsage.test.ts`
Expected: FAIL because no interactive-usage event or segment-linked token writer exists.

- [ ] **Step 3: Add a closed usage event contract**

```ts
export interface InteractiveUsageSample {
  eventId: string;
  provider: AgentProvider;
  providerSessionId: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  observedAt: string;
}
```

The contract mirrors `TokenUsage`: cache reads and cache writes are independent counters and must never be collapsed into a single `cachedInput` value. An installed provider bridge may emit `UsageUpdate` only when the provider supplied cumulative numeric counts and a stable provider event/message id. It must never estimate from transcript size, terminal text, elapsed time, or model output. Preserve a provider-reported total when present; otherwise derive the total from the four normalized counters using the existing token-usage semantics.

- [ ] **Step 4: Persist cumulative samples before calculating deltas**

Increment `SCHEMA_VERSION` to 29 and add this durable source table plus nullable `interactive_usage_sample_id` on `token_usage`:

```sql
CREATE TABLE IF NOT EXISTS interactive_usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  implementation_segment_id INTEGER REFERENCES implementation_segments(id) ON DELETE SET NULL,
  source_event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  counter_epoch INTEGER NOT NULL DEFAULT 0,
  baseline_only INTEGER NOT NULL DEFAULT 0 CHECK (baseline_only IN (0,1)),
  observed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_usage_event
  ON interactive_usage_samples(provider, provider_session_id, source_event_id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_segment
  ON interactive_usage_samples(implementation_segment_id, id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_process
  ON interactive_usage_samples(process_run_id, id);
CREATE INDEX IF NOT EXISTS idx_interactive_usage_provider_session
  ON interactive_usage_samples(provider, provider_session_id, id);
```

The v29 migration also adds nullable `interactive_usage_sample_id INTEGER REFERENCES interactive_usage_samples(id) ON DELETE SET NULL` to `token_usage` plus a partial unique index for non-null sample ids. In one transaction, resolve the accepted provider session's **current process binding**, reject an already-recorded `(provider, provider_session_id, source_event_id)` idempotently, read the preceding persisted sample for that provider session/epoch across every Karst process, append the cumulative sample with required `process_run_id` and optional `implementation_segment_id`, and append at most one non-negative delta row to `token_usage(process_run_id=..., implementation_segment_id=..., interactive_usage_sample_id=sample.id)`. Use `call_site='implementation'` for the Session process and `call_site='fix-resume'` for a Fix process. Process linkage answers where the increment occurred; provider-session linkage is the baseline scope. Never reopen or misattribute an Implementation segment for Fix usage, and never reset the baseline merely because Karst changed process/segment ownership.

For a proven-new session, compare the first sample against implicit zero and write the full reported counts. For an unproven/resumed session with no stored predecessor, persist `baseline_only=1`, emit no accounting row, and use it as the next delta's predecessor. If the same provider session later moves between Karst processes or segments, carry forward its latest persisted counters and `counter_epoch`; only the new increment belongs to the new owner. A counter decrease increments the epoch; count the reset observation from zero only when the confirmed binding proves continuous instrumentation, otherwise baseline it. Later samples subtract only the preceding sample for that provider session in the same persisted epoch. Add `implementation` to the closed AI call-site set and retain `fix-resume`; the source row makes replay idempotent and the explicit baseline flag prevents pre-instrumentation usage from being billed to this ticket.

- [ ] **Step 5: Make supported provider bridges produce UsageUpdate**

- Codex: extend `CODEX_HOOK_BRIDGE` in `codex.ts` to forward authoritative cumulative input/output/cache-read/cache-write/total usage and the provider event id instead of discarding them while normalizing lifecycle events.
- OpenCode: extend the generated bridge in `opencode.ts` to observe its token-bearing step/message completion event and post the same normalized usage payload without folding cache writes into cache reads.
- Claude Code: keep `interactiveUsage: false`. Its documented `Stop` payload exposes `session_id`, `stop_hook_active`, and `last_assistant_message`; `SessionEnd` adds only `reason`. Neither event supplies authoritative token counters plus a stable usage-event id, so do not invent token-bearing fixtures or parse transcripts. Pin this against captured payloads matching the official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
- Antigravity: keep `interactiveUsage: false` because the adapter has no lifecycle channel; its test pins truthful absence.

Use captured provider event fixtures in `codex.test.ts` and `opencode.test.ts` to prove each supported bridge actually posts `UsageUpdate`, and prove malformed/partial usage is dropped before it reaches the store. In the existing Claude settings tests, assert documented `Stop`/`SessionEnd` payloads remain lifecycle-only and the provider capability remains false.

- [ ] **Step 6: Preserve absence for unsupported provider events**

When a provider exposes no authoritative usage fields, its bridge emits no `UsageUpdate`; the process remains token-absent. Add a capability result to `provider.ts` so reducers can distinguish “not measured” from a measured zero without inventing a count.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run src/agent/interactiveUsage.test.ts src/store/interactiveUsageSamples.test.ts src/agent/settings.test.ts src/agent/codex.test.ts src/agent/opencode.test.ts src/agent/antigravity.test.ts src/hooks/endpoint.test.ts src/hooks/dispatch.test.ts src/store/tokenUsage.test.ts src/workflow/tokenUsageAttribution.test.ts`
Expected: PASS.
Commit: `feat: record measured interactive token deltas`

### Task 6: Persist Causal Recovery Rounds and Cap Snapshots

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/recoveryRounds.ts`
- Create: `src/store/recoveryRounds.test.ts`
- Modify: `src/store/sessionLaunchIntents.ts`
- Modify: `src/store/sessionLaunchIntents.test.ts`
- Modify: `src/workflow/gates/commit.ts`
- Create: `src/workflow/gates/commit.test.ts`
- Modify: `src/workflow/stages/uat.ts`
- Modify: `src/workflow/stages/uat.test.ts`
- Modify: `src/workflow/stages/review.ts`
- Modify: `src/workflow/stages/review.test.ts`
- Modify: `src/workflow/fixAttempts.ts`
- Modify: `src/workflow/fixAttempts.test.ts`
- Create: `src/workflow/fixExecution.ts`
- Create: `src/workflow/fixExecution.test.ts`
- Modify: `src/workflow/stages/fix.ts`
- Modify: `src/workflow/stages/fix.test.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/workflow/driveTicket.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/ui/session.test.ts`
- Modify: `src/cli/stage.ts`
- Modify: `src/cli/stage.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `RecoveryTriggerInput`, `openRecoveryRound`, `beginLiveFixExecution`, `recordFixLaunchIntent`, `confirmFixLaunch`, `completeFixExecution`, `interruptFixExecution`, `activeRecoverySeries`, `recoveryDecision`.
- Consumes: a complete trigger snapshot built where UAT/Review still know the failing evidence and manifest cap; production Fix entry through `resumeFixSession` (live nudge or relaunched session); and the explicit `stage fix pass` marker as completion authority. AI Tester observations alone are never accepted as a recovery trigger.

- [ ] **Step 1: Write failing historical-stability tests**

```ts
expect(activeRecoverySeries(store, ticketId, 'review')?.maxRounds).toBe(2);
manifest.review!.maxFixAttempts = 5;
expect(recoveryDecision(store, ticketId, 'review').maxRounds).toBe(2);
```

Add cases for source process identity, round ordering, exhaustion, a Fix process-run link, and an execution crash that creates no recovery round. Exercise both production branches: a live-session nudge opens and attaches exactly one Fix process run before the prompt is delivered; a closed-session relaunch persists a `session_launch_intents(purpose='fix')` row linked to the recovery round but opens/attaches the process run only when the matching `SessionStart` is accepted. Prove `src/workflow/stages/fix.ts::runFix` is not required for production tracking. The real `stage fix pass` marker must atomically pass the process run, move the recovery round to `revalidating`, and follow the only legal graph edge `fix -> uat`; a rejected marker mutates none of them. For a Review-origin round, prove UAT is attached and must pass before the later Review run is attached; no direct Fix-to-Review transition is attempted.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/workflow/gates/commit.test.ts src/workflow/fixAttempts.test.ts src/workflow/fixExecution.test.ts src/workflow/driveTicket.test.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts src/hooks/dispatch.test.ts src/ui/session.test.ts src/cli/stage.test.ts`
Expected: FAIL because recovery evidence and snapshotted policy are absent.

- [ ] **Step 3: Add recovery evidence schema**

```sql
CREATE TABLE IF NOT EXISTS recovery_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  source_stage TEXT NOT NULL CHECK (source_stage IN ('uat','review')),
  source_process_id TEXT NOT NULL,
  source_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  source_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  trigger_kind TEXT NOT NULL,
  trigger_detail TEXT NOT NULL,
  round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  fix_process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  uat_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  review_revalidation_stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','fixing','revalidating','passed','failed','exhausted','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_round
  ON recovery_rounds(ticket_id, source_stage, round);
```

Increment `SCHEMA_VERSION` to 30 and mirror the table/index in the fresh schema. Add nullable `recovery_round_id INTEGER REFERENCES recovery_rounds(id) ON DELETE CASCADE` to `session_launch_intents`; it is required when `purpose='fix'` and absent for Implementation intents. This gives a pending Fix launch a durable owner before its process run exists.

- [ ] **Step 4: Open the round with the failing outcome transaction**

Add a closed call-site payload to `CommitGateOutcomeInput`:

```ts
type RecoveryTriggerInput = {
  sourceProcessId: 'gates' | 'tester' | 'review';
  sourceStageRunId: number;
  sourceProcessRunId: number | null;
  triggerKind: 'gate-failure' | 'tester-verifier-failure' | 'blocking-review-findings';
  triggerDetail: string;
  maxRounds: number;
};
```

UAT and Review construct this payload **before** calling `commitGateOutcome`, while they still have the failing gate/verifier/finding identity, the current `stageRunId`, the AI process-run id when the source was Tester/Review, and the manifest cap. A deterministic failed UAT gate uses `sourceProcessId='gates'` with a null process run; Task 8's verifier exit uses `sourceProcessId='tester'` with the Tester process run; blocking Review findings use `sourceProcessId='review'` with the Review process run; Review gate failures use `gates`. Execution errors/blocks and advisory Tester observations pass no trigger. Validate the payload against the actual outcome: a trigger is legal only with a failed verdict from UAT/Review, and a failed verdict that enters automatic recovery must carry one. Do not overload one id column with two table identities, and do not reconstruct source or cap later from `stages.verdict`, latest findings, or mutable Settings.

Extend `commitGateOutcome`'s transition premutation to pass this complete snapshot to `openRecoveryRound`, so the failing verdict, recorded gate/finding evidence, source process/run, causal detail, round number, and `max_rounds` commit atomically. Subsequent driver decisions read the committed round id and `max_rounds` from the active series rather than the live manifest. Tests must force a transaction failure after the insert and prove neither verdict nor recovery row survives, then cover every trigger kind and the no-trigger execution-error branch.

- [ ] **Step 5: Link Fix and revalidation evidence**

Do not wire this through `src/workflow/stages/fix.ts::runFix`: production recovery never calls that headless helper. Thread the committed recovery-round id through `driveTicket`'s `resumeFix` callback into the existing `extension.ts::resumeFixSession` path.

- **Live session:** use the session manager's recorded active provider/model snapshot, then transactionally open `process_runs(process_id='fix')` and attach it to the recovery round immediately before delivering the Fix brief. If delivery fails, mark both execution and round interrupted.
- **Closed session:** persist a Fix launch intent containing `recovery_round_id`, assignment snapshot, launch id, and session origin from `onLaunchPrepared`; the matching accepted `SessionStart` transactionally opens the Fix process run, attaches it to both intent and round, and confirms the intent. `onLaunchFailed`, supersession, or a stale/mismatched start resolves the intent without creating a process run.
- **Usage:** while a Fix execution is active, `UsageUpdate` computes deltas from Task 5's provider-session baseline and owns each sample with the active Fix `processRunId`, no Implementation segment, and `call_site='fix-resume'`; ordinary Session samples use their Session process run plus optional Implementation segment and `call_site='implementation'`.
- **Completion:** route the parsed `fix` marker through a workflow helper that calls the existing `transition(..., premutate)` from `fix` with a passed verdict. The premutation marks the linked Fix process run passed and the recovery round revalidating; the graph itself moves the ticket to UAT. A session crash marks both interrupted and consumes no additional round.
- **Revalidation:** `openGateRun`/the UAT stage attaches the next UAT `stage_run` to `uat_revalidation_stage_run_id`. For a UAT-origin round, that UAT outcome completes or fails the round. For a Review-origin round, a passing UAT leaves the round revalidating; when the driver subsequently reaches Review, its new run is attached to `review_revalidation_stage_run_id`, and only that Review outcome completes/fails the original round. If the intermediate UAT fails, mark the Review-origin round failed and let the atomically created UAT recovery round describe the new cause. Never call `transition()` directly from Fix to Review and never skip UAT.

Keep `runFix` only if another tested caller still needs it; otherwise remove it rather than presenting a second, untracked production route.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/workflow/gates/commit.test.ts src/workflow/fixAttempts.test.ts src/workflow/fixExecution.test.ts src/workflow/driveTicket.test.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts src/workflow/stages/fix.test.ts src/hooks/dispatch.test.ts src/ui/session.test.ts src/cli/stage.test.ts`
Expected: PASS.
Commit: `feat: persist causal recovery rounds`

### Task 7: Add Process Assignment Configuration and Snapshots

**Files:**
- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/schema.ts`
- Create: `src/manifest/validate/processAssignments.ts`
- Create: `src/manifest/validate/processAssignments.test.ts`
- Modify: `src/manifest/load.test.ts`
- Modify: `src/manifest/write.ts`
- Modify: `src/manifest/writeManifest.test.ts`
- Create: `src/agent/processAssignment.ts`
- Create: `src/agent/processAssignment.test.ts`
- Modify: `src/ui/settings/webview.html`
- Modify: `src/ui/settings/webview.test.ts`
- Modify: `src/ui/settings/sections.ts`
- Modify: `src/ui/settings/sections.test.ts`
- Modify: `karst.example.yml`

**Interfaces:**
- Produces: `ProcessAssignmentConfig`, `ProcessAssignmentsConfig`, `resolveProcessAssignment(manifest, role, ticketOverride)`.
- Consumes: existing agent-provider/model catalog and role-keyed `agents`; the resolver returns a snapshot ready for `openProcessRun`.

- [ ] **Step 1: Write failing validation/resolution tests**

```ts
expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
  agentName: 'UAT Agent', provider: 'codex', model: 'sol',
});
```

Prove unknown process keys, malformed assignments, unknown providers, and undeclared agent references are named manifest errors; prove a valid `processes:` block survives load → write → load byte-for-byte in meaning; prove defaults resolve when config is absent and a later Settings edit does not mutate an already stored `process_runs` row.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/agent/processAssignment.test.ts src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts`
Expected: FAIL because process assignments are not modeled.

- [ ] **Step 3: Add explicit process configuration**

```ts
export interface ProcessAssignmentConfig {
  agentName?: string;
  agent?: string;
  provider?: AgentProvider;
  model?: string;
  enabled?: boolean;
}

export interface ProcessAssignmentsConfig {
  uatTester?: ProcessAssignmentConfig;
  uatFix?: ProcessAssignmentConfig;
  review?: ProcessAssignmentConfig;
  reviewFix?: ProcessAssignmentConfig;
  prDescription?: ProcessAssignmentConfig;
}

export interface Manifest {
  // existing fields
  processes?: ProcessAssignmentsConfig;
}
```

Absent entries resolve to the approved defaults (`UAT Agent`, `UAT Fix Agent`, `Review Agent`, `Review Fix Agent`, and the ticket-resolved PR-description adapter). The `agent` field references an existing role-keyed agent profile; `agentName` is its display snapshot override. Do not add provider/model fields to `AgentDef`, whose existing meaning remains a subagent prompt profile.

- [ ] **Step 4: Wire validation and round-trip persistence**

```ts
const agents = validateAgents(raw.agents);
const processes = validateProcessAssignments(raw.processes, agents);
return {
  // existing validated fields
  agents,
  processes,
};
```

`validateManifest` in `src/manifest/schema.ts` must call the new validator and include `processes` in its returned `Manifest`; `writeManifest` in `src/manifest/write.ts` must explicitly overlay `processes: manifest.processes` so an explicit save cannot drop it. Pin both seams in `load.test.ts` and `writeManifest.test.ts`.

- [ ] **Step 5: Add tab-scoped Settings fields**

Add `processes` to the Agents section's `SECTION_FIELDS`, render five process assignment rows on the Agents tab, and spread the existing `processes` object on save so hidden/future entries survive. Recovery limits remain under the Quality section's existing `uat`/`review` ownership. Mirror closed provider/model choices from host-supplied catalogs, not HTML literals.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/agent/processAssignment.test.ts src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts`
Expected: PASS.
Commit: `feat: configure inside ai process assignments`

### Task 8: Implement UAT Tester Evidence, Deterministic Verification, and Explicit Review Execution Outcomes

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/validate/uat.ts`
- Modify: `src/manifest/validate/uat.test.ts`
- Modify: `src/manifest/load.test.ts`
- Modify: `src/manifest/writeManifest.test.ts`
- Modify: `karst.example.yml`
- Create: `src/store/uatFindings.ts`
- Create: `src/store/uatFindings.test.ts`
- Create: `src/workflow/uat/tester.ts`
- Create: `src/workflow/uat/tester.test.ts`
- Create: `src/workflow/uat/testerVerifier.ts`
- Create: `src/workflow/uat/testerVerifier.test.ts`
- Modify: `src/workflow/stages/uat.ts`
- Modify: `src/workflow/stages/uat.test.ts`
- Modify: `src/workflow/review/findingsLane.ts`
- Modify: `src/workflow/review/findingsLane.test.ts`
- Modify: `src/workflow/stages/review.ts`
- Modify: `src/workflow/stages/review.test.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/workflow/driveTicket.test.ts`
- Modify: `src/agent/aiCallSites.ts`
- Modify: `src/extension.ts`
- Modify: `src/extensionActivation.test.ts`

**Interfaces:**
- Produces: `runUatTester`, advisory `TesterObservation`, `runTesterVerifier`, deterministic `TesterVerificationOutcome`, explicit Review process outcomes `validated | blocking | execution-failed | interrupted`, and production `DriveTicketDeps` seams for resolved Tester/Review assignments, instrumented adapters, and the verifier runner.
- Consumes: resolved assignment snapshots, target list, `processRunId`, instrumented adapter, and optional validated `uat.testerVerifier: GateDef` run through an injected host `GateRunner`; its exit code is the sole Tester-specific UAT verdict. `extension.ts` remains the composition root that resolves adapters/assignments and applies `instrument(...)` before handing them to `driveTicket`.

- [ ] **Step 1: Write failing Tester tests**

```ts
expect(await runUatTester(input, deps)).toEqual({ kind: 'observed', findingIds: [1, 2] });
expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
  processId: 'tester', resultKind: 'observed',
});
expect(await runTesterVerifier(input, { run: async () => ({ exitCode: 1 }) }))
  .toEqual({ kind: 'failed', exitCode: 1 });
```

Cover observations with and without blocking-severity findings, malformed output, adapter crash, cancellation, target linkage, and `uat-tester` token attribution. Prove none of those AI-authored result shapes transitions UAT or opens a recovery round. Separately cover verifier exit 0, nonzero, cancellation, execution failure, and no verifier configured; only a completed nonzero exit code is a deterministic validation failure eligible for recovery, while absence keeps Tester advisory and leaves progression to the ordinary UAT gates. At the production boundary, call the real `driveTicket` with spies from the extension composition seam and prove the configured Tester assignment reaches `runUat`, the adapter is instrumented exactly once, the verifier runner is supplied, and the opened Tester process id is used for usage/findings. Repeat for Review to prove its configured assignment snapshot and process-run tracking reach the existing findings lane.

- [ ] **Step 2: Write failing Review crash-vs-finding tests**

Prove the existing Review finding behavior remains distinguishable from an adapter crash: a crash records `execution-failed`, exposes the artifact, and does not increment recovery rounds. Also pin that this task does not reuse Review's AI-result reduction as authority for the new UAT Tester.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/manifest/validate/uat.test.ts src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/workflow/uat/tester.test.ts src/workflow/uat/testerVerifier.test.ts src/workflow/stages/uat.test.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts src/workflow/driveTicket.test.ts src/extensionActivation.test.ts`
Expected: FAIL because Tester and explicit execution outcomes are absent.

- [ ] **Step 4: Add structured Tester findings**

```sql
CREATE TABLE IF NOT EXISTS uat_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  process_run_id INTEGER NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  repo TEXT,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT,
  line INTEGER,
  created_at TEXT NOT NULL
);
```

Increment `SCHEMA_VERSION` to 31 and mirror the table/index in the fresh schema. Add optional `testerVerifier?: GateDef` to `UatConfig`, validate it with the existing argv-safe `validateGate` path, preserve it through manifest load/write, and document it in `karst.example.yml`. This is a host-authored command/script definition, not an AI output field. Existing manifests without it remain compatible: Tester findings are advisory and the ordinary UAT gate verdict remains authoritative.

Parse bounded structured JSON using the same untrusted-prose collapsing and file validation principles as Review findings. These rows are evidence/observations only; severity labels are never converted into a stage verdict.

- [ ] **Step 5: Orchestrate Gates → Services context → Tester**

Gates keep deterministic exit-code semantics. Services contributes host-known read-only context. The AI Tester runs only after required gates pass and records observations. When `uat.testerVerifier` is configured, the host runs it through the injected gate boundary: exit 0 completes Tester, a completed nonzero exit code records `result_kind='verification-failed'` and may open recovery, and verifier execution failure parks/retries without consuming a Fix round. Without a verifier, render the Tester observation as advisory/`note` and let the ordinary UAT gate result decide progression. AI findings remain visible under Tester but cannot pass, fail, transition, or spend a recovery round by themselves.

Extend `DriveTicketDeps` with functions that resolve the immutable Tester and Review assignments at process start, return the already instrumented per-ticket adapter, and run the optional Tester verifier through the host gate runner. Thread those dependencies into `runUat`/`runReview` rather than resolving providers inside workflow code. In `extension.ts`, use the same `instrument(resolveAdapter(...), provider)` composition path pinned by `src/ui/usage/wiring.test.ts`; pass the process run id through `tracking.processRunId`. Open each Tester/Review process run before the AI call, snapshot assignment identity there, finish it with the explicit result kind after the call, and mark execution failures/interruption without creating a recovery trigger. Add a wiring test that fails if either workflow can pass focused unit tests while remaining unreachable from the extension composition root.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/manifest/validate/uat.test.ts src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/store/uatFindings.test.ts src/workflow/uat/tester.test.ts src/workflow/uat/testerVerifier.test.ts src/workflow/stages/uat.test.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts src/workflow/driveTicket.test.ts src/workflow/tokenUsageAttribution.test.ts src/ui/usage/wiring.test.ts src/extensionActivation.test.ts`
Expected: PASS.
Commit: `feat: add uat tester execution evidence`

### Task 9: Persist Ship as a Reconciled Per-Repository Saga

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/shipRuns.ts`
- Create: `src/store/shipRuns.test.ts`
- Modify: `src/integrations/git.ts`
- Modify: `src/integrations/git.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/stages/ship.test.ts`
- Modify: `src/workflow/prDescription.ts`

**Interfaces:**
- Produces: `openShipRun`, `beginShipOperationPreparation`, `finalizeShipOperationIntent`, `markShipOperationApplied`, `reconcileShipOperation`, `openShipRepoStep`, `finishShipRepoStep`, `recordShipCommit`, `listShipEvidence`; discriminated `ShipOperationPreState`/`ShipOperationIntent` records and richer Git primitives `prepareCommitInQuarantine`, `promoteQuarantinedObjects`, `compareAndSwapHeadAndIndex`, `workingTreeSummary`, `listCommitsFrom`, `headCommit`, `remoteRefSha`.
- Consumes: existing PR/current merge checks and the `pr-description` process run.

- [ ] **Step 1: Write failing persistence/restart tests**

```ts
expect(listShipEvidence(store, ticketId).repos.web).toMatchObject({
  push: { status: 'passed' },
  pr: { existedBeforeShip: false, number: 413 },
});
expect(listShipEvidence(store, ticketId).repos.api.commits[0]).toMatchObject({ origin: 'before-ship' });
```

Cover partial success, adopted PR, existing human description preservation, created commit SHA, push failure, and rerun reconciliation. For Commit, inject crashes after the durable `preparing` row, during temporary-index/quarantine preparation, after the complete intent is finalized, during object promotion, after the HEAD compare-and-swap, and before index normalization. For every other irreversible boundary—`git push`, PR body update, and PR creation—inject a crash immediately after the external side effect but before the result write. Reopen the store and prove reconciliation uses persisted typed ownership/pre-state/intent to adopt only the exact intended effect. Also prove an intervening human commit, index change, worktree change, or body edit makes reconciliation stop for user input rather than label that change `created-by-ship` or overwrite it.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/shipRuns.test.ts src/integrations/git.test.ts src/workflow/stages/ship.test.ts`
Expected: FAIL because Ship evidence is transient and Git probes are too weak.

- [ ] **Step 3: Add Ship saga schema**

```sql
CREATE TABLE IF NOT EXISTS ship_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS ship_repo_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('commit','push','describe','pr')),
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','note')),
  detail TEXT NOT NULL,
  pr_number INTEGER,
  pr_status TEXT,
  existed_before_ship INTEGER,
  process_run_id INTEGER REFERENCES process_runs(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS ship_operation_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('commit','push','describe','pr')),
  operation_key TEXT NOT NULL UNIQUE,
  pre_state_json TEXT NOT NULL,
  intent_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('preparing','prepared','applied','reconciled','failed','ambiguous')),
  created_at TEXT NOT NULL,
  prepared_at TEXT,
  applied_at TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS ship_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_run_id INTEGER NOT NULL REFERENCES ship_runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('before-ship','created-by-ship'))
);
```

Increment `SCHEMA_VERSION` to 32 and mirror all four tables/indexes in the fresh schema. Add nullable `operation_intent_id INTEGER REFERENCES ship_operation_intents(id) ON DELETE SET NULL` to `ship_repo_steps`. `pre_state_json` is always present before preparation can touch Git/GitHub; `intent_json` is nullable only while a Commit row is `preparing`. Both are parsed through closed TypeScript unions keyed by `step`, never exposed as arbitrary webview data:

```ts
type PersistedCommitIdentity = {
  name: string;
  email: string;
  at: string; // exact Git author/committer timestamp including offset
};

type ShipOperationPreState =
  | {
      step: 'commit';
      preHead: string;
      preIndexTree: string;
      worktreeFingerprint: string;
      message: string;
      author: PersistedCommitIdentity;
      committer: PersistedCommitIdentity;
      quarantineKey: string;
    }
  | { step: 'push'; localHead: string; remote: string; ref: string; preRemoteHead: string | null }
  | { step: 'describe'; prUrl: string; preBodyHash: string }
  | { step: 'pr'; head: string; base: string | null; preExistingUrl: string | null };

type ShipOperationIntent =
  | { step: 'commit'; intendedTree: string; expectedHead: string; quarantineKey: string }
  | { step: 'push'; localHead: string; remote: string; ref: string; preRemoteHead: string | null }
  | { step: 'describe'; prUrl: string; preBodyHash: string; intendedBody: string }
  | { step: 'pr'; head: string; base: string | null; title: string; body: string; preExistingUrl: string | null };
```

`quarantineKey` is a host-generated UUID, not a path. Git code derives one fixed directory beneath the repository git-dir, proves canonical containment, and never accepts a cleanup path from stored JSON or a caller. Validate decoded rows and legal status/data combinations: `preparing` requires valid pre-state and `intent_json IS NULL`; every later state requires both. Malformed/unknown data becomes `ambiguous`, never permission to prepare, clean up, or repeat an operation.

- [ ] **Step 4: Write before/after evidence around every external operation**

For Push, Description, and PR creation, persist complete pre-state and intent in the same transaction that opens the `running` step before the external call. Commit has an explicit preliminary state because its exact tree/object ids do not exist until Git preparation runs: first persist the complete immutable Commit pre-state with `status='preparing'` and open the step in one transaction; only that owned row authorizes temporary preparation. After any operation returns, persist the observed result and mark the intent `applied`/step terminal. A retry first loads the durable row and compares current Git/GitHub state with both its pre-state and intended state:

- Commit preparation never mutates the live index, refs, or main object database. After the `preparing` row commits, derive the quarantine directory from its UUID, build a temporary index there from `preHead`, stage the intended worktree content into that index, and write tree/commit objects into a quarantined object directory using the persisted message/identity/timestamps. In a second transaction persist `intendedTree`/`expectedHead` and change the row to `prepared`. A crash while `preparing` is therefore owned and recoverable: if HEAD, live-index tree, and worktree fingerprint still match pre-state, remove only that row's canonically contained quarantine and rebuild; otherwise mark it ambiguous. No branch or live-index change may be attributed to a `preparing` row.
- Commit apply starts only from `prepared`. Idempotently promote the quarantined objects, then re-check `preHead`, `preIndexTree`, and the worktree fingerprint. Use an index lock containing `intendedTree` and compare-and-swap `HEAD` from `preHead` to `expectedHead`; after the CAS, atomically install that index. Recovery adopts only when HEAD equals `expectedHead`, the worktree still matches the intended fingerprint, and the live index is either the recorded pre-index or `intendedTree`, completing the owned index install when necessary. If HEAD is still `preHead`, apply may retry only while index/worktree preconditions still match. Any third HEAD, index tree, worktree fingerprint, quarantine mismatch, or pre-existing lock is ambiguous and is never overwritten. The exact expected object id—not message heuristics—is what authorizes `created-by-ship` provenance.
- Push: compare the recorded local HEAD and pre-operation remote ref with the current remote ref; adopt only the exact intended SHA.
- Description: compare the current PR body hash with the recorded prior hash and intended body; preserve any third value as a human/intervening edit.
- PR creation: probe by recorded head/base and adopt the matching PR; never invent a number or open a second PR while the probe is degraded.

Test the preliminary ownership write itself transactionally, owned-quarantine cleanup by exact UUID, refusal to touch an unowned quarantine directory, every preparation/apply crash point, restart/reload, exact adoption, ambiguous HEAD/index/worktree divergence, and partial success in another repo. A `running` step without a valid matching ownership row never authorizes preparation, cleanup, replay, or provenance.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/store/shipRuns.test.ts src/integrations/git.test.ts src/workflow/stages/ship.test.ts src/workflow/prDescription.test.ts`
Expected: PASS.
Commit: `feat: persist ship provenance and partial progress`

### Task 10: Build Scope and Implementation Process Reducers

**Files:**
- Create: `src/model/inside/bounds.ts`
- Create: `src/model/inside/bounds.test.ts`
- Modify: `src/model/inside/agent.ts`
- Modify: `src/model/inside/agent.test.ts`
- Modify: `src/model/inside/index.ts`
- Modify: `src/model/inside/index.test.ts`

**Interfaces:**
- Produces: `scopeProcesses`, `implementationSessionProcess`, bounded evidence views.
- Consumes: selected repos, worktrees, implementation timeline, phase marks, optional recorded tokens.

- [ ] **Step 1: Write failing aggregation/timeline tests**

Prove one Hot set row and one Worktrees row regardless of repository count; bounded evidence returns `remaining = total - shown`. Prove one session contains provider segments/switch annotations, repeated phase events remain chronological, and missing Implementation tokens are omitted.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/model/inside/bounds.test.ts src/model/inside/agent.test.ts src/model/inside/index.test.ts`
Expected: FAIL because reducers still emit flat per-repo rows.

- [ ] **Step 3: Implement bounded evidence helper**

```ts
export function bounded<T>(items: readonly T[], limit: number): { shown: readonly T[]; remaining: number } {
  return { shown: items.slice(0, limit), remaining: Math.max(0, items.length - limit) };
}
```

- [ ] **Step 4: Implement process reducers**

Implementation timeline rows use `phase | switch | start` discriminants. A switch row carries no status node. Pending configured identity appears only before execution; recorded segments always win after start.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/model/inside/bounds.test.ts src/model/inside/agent.test.ts src/model/inside/index.test.ts`
Expected: PASS.
Commit: `feat: reduce scope and implementation inside processes`

### Task 11: Build UAT, Review, and Conditional Fix Reducers

**Files:**
- Modify: `src/model/inside/gates.ts`
- Modify: `src/model/inside/gates.test.ts`
- Create: `src/model/inside/recovery.ts`
- Create: `src/model/inside/recovery.test.ts`
- Modify: `src/model/inside/index.ts`
- Modify: `src/model/inside/index.test.ts`

**Interfaces:**
- Produces: `uatProcesses`, `reviewProcesses`, `insertCausalFix`.
- Consumes: gate/stage runs, service config context, Tester/Review process runs/findings, recovery rounds, token summaries.

- [ ] **Step 1: Write failing causal-order tests**

```ts
expect(views.uat.processes.map((p) => p.id)).toEqual(['gates', 'fix', 'services', 'tester']);
expect(views.review.processes.map((p) => p.id)).toEqual(['gates', 'services', 'review', 'fix']);
```

Cover gate-triggered and deterministic Tester-verifier-triggered UAT Fix, advisory Tester findings that create no Fix, Review gate/finding Fix, no Fix without recovery evidence, execution crash without a round, exhaustion without an extra Fix row, stored max stability, stale `stage_runs`/`process_runs`, and settings-vs-recorded identity.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/model/inside/gates.test.ts src/model/inside/recovery.test.ts src/model/inside/index.test.ts`
Expected: FAIL because causal process nesting is absent.

- [ ] **Step 3: Reduce evidence without status inference**

Use latest explicit invocation ids, not array position or human-readable detail. Pending config may describe gate names/services/agent assignment; pass/run/fail requires recorded rows. Disabled gates remain `skip`, missing gates remain `note`.

- [ ] **Step 4: Insert Fix immediately after its trigger**

```ts
export function insertCausalFix(
  processes: readonly InsideProcessView[],
  recovery: RecoveryProcessView | null,
): InsideProcessView[] {
  if (!recovery) return [...processes];
  const index = processes.findIndex((process) => process.id === recovery.triggerProcessId);
  return index < 0
    ? [...processes, recovery.process]
    : [...processes.slice(0, index + 1), recovery.process, ...processes.slice(index + 1)];
}
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/model/inside/gates.test.ts src/model/inside/recovery.test.ts src/model/inside/index.test.ts`
Expected: PASS.
Commit: `feat: render causal recovery inside quality stages`

### Task 12: Build Ship and Done Receipt Reducers

**Files:**
- Create: `src/model/inside/ship.ts`
- Create: `src/model/inside/ship.test.ts`
- Create: `src/model/inside/done.ts`
- Create: `src/model/inside/done.test.ts`
- Modify: `src/model/inside/index.ts`
- Modify: `src/model/inside/index.test.ts`
- Modify: `src/store/tokenUsage.ts`

**Interfaces:**
- Produces: `shipProcesses`, `doneReceipt`, typed commit/PR link evidence.
- Consumes: durable Ship evidence, current PRs/merge checks, final gate batches, recovery rounds, recorded-only token summaries.

- [ ] **Step 1: Write failing Ship reducer tests**

Cover process order, commit provenance, aggregate counts at 20 repos, adopted vs created PR, missing PR number before creation, current PR beating stale merged PR, partial error preservation, draft/open waits, and merge conflict as `wait` rather than a failed verdict.

- [ ] **Step 2: Write failing Done tests**

```ts
expect(doneReceipt({ stageCurrent: 'ship', evidence })).toEqual({
  status: 'pending',
  title: 'Delivery receipt pending',
  detail: 'Available after every current pull request is merged',
});
expect(doneReceipt({ stageCurrent: 'done', evidence })).toMatchObject({
  status: 'complete',
  tokens: { label: expect.stringContaining('recorded') },
});
```

Prove merged PRs only, final gate wording, recovery history, Ship-created commits, role breakdown, exclusion of estimated tokens, and omission of unknown legacy facts.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/model/inside/ship.test.ts src/model/inside/done.test.ts src/model/inside/index.test.ts src/store/tokenUsage.test.ts`
Expected: FAIL because Ship provenance and Done receipt reducers do not exist.

- [ ] **Step 4: Implement current-state and historical separation**

PR/Merge reducers use current `prs`/`merge_checks`; commit/push/description provenance uses append-only Ship evidence. `doneReceipt` always returns the discriminated union `{ status: 'pending', title, detail } | { status: 'complete', delivered, validated, tokens, evidence }`: before actual `done` it contains no future delivery evidence, and after `done` it never treats estimated token rows as recorded.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/model/inside/ship.test.ts src/model/inside/done.test.ts src/model/inside/index.test.ts src/store/tokenUsage.test.ts`
Expected: PASS.
Commit: `feat: reduce ship evidence into done delivery receipt`

### Task 13: Assemble Dashboard State, Live Operations, and Typed Actions

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/state.test.ts`
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Create: `src/ui/dashboard/insideActions.ts`
- Create: `src/ui/dashboard/insideActions.test.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`
- Modify: `src/workflow/gates/runList.ts`
- Modify: `src/workflow/gates/runList.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `InsideProgressEvent`, `LiveOperationView`, `InsideActionRegistry`, host-only `InsideActionTarget`, and the closed `{ type: 'inside-action'; actionId: string }` message.
- Consumes: all store readers once per dashboard snapshot and preformatted host reducers.

- [ ] **Step 1: Write failing snapshot/projection tests**

Prove `stageCurrent='fix'` selects the causal UAT/Review presentation, `DashboardState.inside` excludes a peer Fix stage, and every store source is read into the reducer exactly once.

- [ ] **Step 2: Write failing protocol tests**

```ts
expect(parseDashboardMessage({ type: 'inside-action', actionId: 'snapshot-7:action-3' })).toEqual({
  type: 'inside-action',
  actionId: 'snapshot-7:action-3',
});
expect(parseDashboardMessage({
  type: 'inside-action',
  actionId: 'forged',
  path: '/private/etc/passwd',
})).toBeNull();
```

Cover malformed/oversized action ids, rejection of every legacy target-bearing payload, unknown/stale/other-ticket ids, snapshot replacement/disposal, action-result lifecycle, `active → completed(pass)` clearing the live header while retaining the successful process row, `cleared` without a verdict, and a generic live event replacing webview-derived Ship steps. In `insideActions.test.ts`, prove an `open-file` target re-loads its finding/evidence row by host-owned id, rejects evidence from another ticket or repository, rejects absolute paths, `..`, missing repository mappings, and existing or not-yet-existing symlink escapes, and opens only a canonical descendant of the recorded worktree. Also prove changing a client-supplied `kind`, repo, path, PR number, SHA, stage, or process id cannot affect dispatch because none is accepted from the message.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/workflow/gates/runList.test.ts`
Expected: FAIL because richer state and protocol variants are absent.

- [ ] **Step 4: Emit started and finished live events**

```ts
export type InsideProgressEvent =
  | {
      kind: 'active';
      ticketId: number;
      stage: InsideStageKey;
      processId: string;
      live: LiveOperationView; // status: run | wait | fail
    }
  | {
      kind: 'completed';
      ticketId: number;
      stage: InsideStageKey;
      process: InsideProcessView; // pass | fail | note | skip with final evidence
    }
  | {
      kind: 'cleared';
      ticketId: number;
      stage: InsideStageKey;
      processId: string;
    };
```

Gate runners emit `active` before start and `completed` after every terminal result, including success. A completed event replaces that process row and clears the matching live header; `cleared` handles cancellation/snapshot supersession without inventing a terminal result. Review findings, Tester, Fix, and Ship translate progress into the same host-owned union. `messages.ts` validates the discriminant/status combinations, `panel.ts` forwards them, and the following full dashboard snapshot remains authoritative. The webview overlays only the supplied view.

- [ ] **Step 5: Route typed actions**

Build a new `InsideActionRegistry` for every authoritative dashboard snapshot. Reducers register host-only targets and receive only `{ actionId, kind }` for the view; the posted message contains `actionId` alone. Bind each registry entry to the snapshot generation and ticket id, replace the allowlist atomically with the state snapshot, clear it on panel disposal, and reject unknown/stale/cross-ticket ids. The id is an opaque capability, never an encoded target, and the dispatch branch is selected from the stored target rather than any client field.

Host-only targets identify recorded objects, for example `{ kind: 'open-file'; ticketId; evidence: { source: 'review-finding'; id } }`, `{ kind: 'open-pr'; ticketId; prId }`, or `{ kind: 'open-commit'; ticketId; shipCommitId }`; they do not accept a client path/URL/repo/number/SHA. On file dispatch, re-load the evidence row, verify its `ticket_id`, resolve its repository through the ticket's current registered worktree, reject absolute/empty/traversal paths, canonicalize the deepest existing ancestor for missing leaves, and require `isPathUnder(candidate, worktreeRoot)` before constructing the VS Code URI. Existing symlinks must be resolved before containment. Apply equivalent ticket ownership checks before resolving PR, commit, log, resume, and full-evidence targets. The visible `kind` remains presentation-only and nested links post only the opaque id.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/insideActions.test.ts src/ui/dashboard/panel.test.ts src/workflow/gates/runList.test.ts src/workflow/stages/ship.test.ts`
Expected: PASS.
Commit: `feat: unify inside live operation and action protocol`

### Task 14: Replace the Flat Inside Webview with Generic Ledger Primitives

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `InsideStageView`, closed evidence union, `TypedInsideAction`, `LiveOperationView`.
- Produces: presentation-only renderers `renderInside`, `renderProcess`, `renderEvidence`, local `openInsideProcesses` state.

- [ ] **Step 1: Add an executed webview harness and failing behavior tests**

Adapt the `node:vm` harness from `src/ui/diffs/webview.test.ts`. Execute real dashboard render functions and assert semantic DOM strings/messages for generic rows, disclosures, escaped prose, unknown process fallback, nested action propagation, and open-state restoration.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL because the current renderer is flat and the new functions/state are absent.

- [ ] **Step 3: Implement shared status/disclosure/link primitives**

Use one CSS geometry for each status, a CSS-drawn centered chevron, `<details>/<summary>` for evidence, true `<button>`/`<a href>` semantics, and visible text/labels so color is secondary. Use only `--k-*` tokens; add no raw colors, spacing, radii, or duration values.

- [ ] **Step 4: Preserve view state locally**

```js
const openInsideProcesses = new Set();
document.addEventListener('toggle', (event) => {
  const details = event.target.closest?.('[data-inside-process]');
  if (!details) return;
  const key = details.dataset.insideProcess;
  details.open ? openInsideProcesses.add(key) : openInsideProcesses.delete(key);
}, true);
```

Key disclosures by `stage:process:evidence` and restore them after snapshot/live rerenders. Nested action handlers stop disclosure toggling without suppressing keyboard activation.

- [ ] **Step 5: Retire webview business derivation**

Remove `SHIP_STEP_ORDER`, `SHIP_BASE_STEPS`, `flattenShipOps`, `shippingView`, and fault/block wording only after equivalent host-preformatted process views/actions are wired. Keep generic Now outside Inside unchanged.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/ui/dashboard/webview.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts`
Expected: PASS.
Commit: `feat: render inside as accessible process ledger`

### Task 15: Add Specialized Timeline, Commit, PR, Recovery, and Receipt Renderers

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: evidence kinds `timeline`, `commits`, `prs`, `recovery`, and `receipt`.
- Produces: specialized render functions with no business derivation.

- [ ] **Step 1: Write failing specialized-render tests**

Cover AI chip after process name, one execution identity per row, token total/input/output, switch arrow without node, current phase highlight not covering rail, PR link separate from status, recovery cause/round/exhaustion, commit origin, pending Done receipt, and completed receipt.

- [ ] **Step 2: Add geometry/source guards**

Assert the timeline slot uses `var(--k-space-8)` and both edge and node center on `50%` of that cell. Assert reduced motion disables spinner animation without removing its visible ring.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL because specialized evidence kinds are not rendered.

- [ ] **Step 4: Implement specialized renderers**

Keep the timeline, Commit, PR, recovery, and receipt functions keyed only by evidence `kind`. Agent icons come from `injectAgentIdentity`; add the dashboard markers and injection order before CSP if not already present. Do not copy prototype SVG or raw CSS values.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/ui/dashboard/webview.test.ts src/ui/dashboard/state.test.ts src/model/inside/agent.test.ts src/model/inside/ship.test.ts src/model/inside/done.test.ts`
Expected: PASS.
Commit: `feat: add specialized inside evidence views`

### Task 16: Verify Responsive, Accessible, and Repository-Scale Behavior

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Create: `src/ui/dashboard/insideFixtures.ts`
- Create: `src/ui/dashboard/insideFixtures.test.ts`
- Create: `src/ui/dashboard/insidePreview.ts`
- Create: `src/ui/dashboard/insidePreview.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: deterministic fixture matrix for 2/5/10/15/20 repositories and all live/error states, plus a development-only `karst.dev.openInsidePreview` command that renders those exact `InsideStageView` snapshots through the production renderer.
- Consumes: production `InsideStageView` shapes. The normal dashboard/state builder never imports fixtures; the preview command is registered only when `context.extensionMode === vscode.ExtensionMode.Development` and refuses to open otherwise.

- [ ] **Step 1: Write failing scale and compact-contract tests**

Prove top-level process count is constant at every repo size, `remaining` is exact, no untrusted value enters HTML unescaped, compact metadata stays attached to its process, and every interactive object is keyboard-semantic. Exercise the development preview boundary: Development mode registers and opens every fixture through the production renderer; Production/Test mode does not register the command; the normal dashboard dependency graph cannot reach `insideFixtures.ts`.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/insidePreview.test.ts src/ui/dashboard/webview.test.ts`
Expected: FAIL until the fixture matrix and compact container rules exist.

- [ ] **Step 3: Add container-responsive layout**

Set container context on Inside and use token-backed compact layouts at supported widths. Preserve status/name first, move agent/token metadata to a second line, keep the same timeline rail cell, wrap PR branches, and prohibit whole-component horizontal scrolling.

- [ ] **Step 4: Perform manual Extension Dev Host verification**

Contribute `karst.dev.openInsidePreview` in `package.json` but hide it from the production command palette with a development-only context key. Register the handler only when `context.extensionMode === vscode.ExtensionMode.Development`; `insidePreview.ts` opens an isolated preview panel, injects a selected checked-in fixture snapshot into the same production render/protocol path, and provides development-only controls outside the delivered Inside DOM for stage/scenario, 2/5/10/15/20 repos, and 300/360/430/normal widths. No fixture write touches SQLite or the real ticket state.

In VS Code, select the checked-in **Run Karst Extension** launch configuration and press F5. Its `preLaunchTask` runs `npm run dev:extension` (build + Electron ABI rebuild), then VS Code launches the Extension Development Host; running the npm script by itself does **not** launch that host. Run **Karst: Open Inside Preview (Development)** and inspect every fixture/width combination. Verify keyboard disclosure navigation, nested actions, focus visibility, reduced motion, long names/paths, and current-operation updates. Also open a real ticket once to prove the production dashboard is not in fixture mode. Record screenshots or notes in the PR description; do not commit generated screenshots unless requested.

- [ ] **Step 5: Run the complete verification gate**

Run: `npm test`
Expected: all Vitest suites pass with zero failures.
Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0 and dashboard asset copied to `dist/`.

- [ ] **Step 6: Request code and UI review, fix blockers, and commit**

Request review against this plan, `docs/superpowers/specs/2026-08-08-inside-redesign-research.md`, the attached approved prototype, and UI-R01–R32. Fix every Critical/Important issue, rerun the full gate, then commit: `feat: complete inside redesign verification`.

## Acceptance mapping

| Specification area | Tasks |
| --- | --- |
| Six-stage registry and unknown-process fallback | 1, 9–14 |
| Immutable AI execution identity | 2–8, 10–13 |
| Implementation switch history/timeline | 4–5, 10, 15 |
| Measured interactive token attribution across Session/Fix and truthful provider absence | 4–6, 10–12 |
| UAT Tester and Review execution distinction | 7–8, 11 |
| Causal Fix and bounded recovery history | 6, 11, 15 |
| Commit/push/PR/merge persistence | 9, 12, 15 |
| Done receipt and recorded-token aggregation | 3, 5, 12, 15 |
| Unified live operation header | 13–15 |
| Typed links/actions and nested disclosure behavior | 1, 13–15 |
| 2/5/10/15/20 repos and 300–430px widths | 10–12, 16 |
| Accessibility and reduced motion | 14–16 |

## Explicit non-deliverables

- Removing the runtime `fix` stage.
- Redesigning the stage rail, Servers, Worktrees, PR, or Gates settings panels beyond fields/actions required by Inside.
- Currency cost claims.
- Backfilling facts the current database never recorded.
- Parsing discarded logs or runner output to manufacture historical evidence.
- Reusing provider-owned session ids as the stable Karst implementation-run id.
