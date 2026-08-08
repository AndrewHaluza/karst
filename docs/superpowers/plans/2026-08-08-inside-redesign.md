# Inside Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a truthful, evidence-backed six-stage Inside component with causal recovery, per-process AI identity/tokens, persistent Ship provenance, and a Done delivery receipt.

**Architecture:** Preserve the runtime stage machine, including its internal `fix` node, and introduce a separate six-stage presentation model built by pure host reducers. Add durable process/run evidence before exposing new facts, write evidence as each operation happens, and keep the standalone webview presentation-only with local selection/disclosure state.

**Tech Stack:** TypeScript 7, Vitest 4, SQLite/better-sqlite3, VS Code webviews with injected Karst design-system CSS/JS, Node ESM.

## Global Constraints

- Runtime lifecycle remains `scope → impl → uat/review → fix when needed → ship → done`; `fix` is projected into Inside UAT/Review, not removed from storage or the graph.
- Done remains an entry condition reached only after every current PR is literally `merged`; unknown PR state is unmerged.
- Verdicts remain deterministic. AI prose never directly transitions the machine; structured validated Tester/Review output is reduced by host code.
- Evidence is written when it happens. Process rows open before work and preserve partial results across extension-host death.
- Settings are future configuration. Every started AI process snapshots agent name, provider, model, and recovery cap where applicable.
- Missing historical facts render as absence, never zero, pass, or reconstructed prose.
- The webview does not order processes, aggregate repositories, derive statuses, parse references, or invent navigation targets.
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
- Produces: `InsideStageKey`, `InsideProcessId`, `InsideProcessView`, `InsideStageView`, `ProcessEvidenceView`, `TypedInsideAction`, `INSIDE_PROCESSES`, `insideStageForRuntimeStage`.
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

export type TypedInsideAction =
  | { kind: 'open-pr'; repo: string; number: number }
  | { kind: 'open-commit'; repo: string; sha: string }
  | { kind: 'open-file'; repo: string; path: string; line?: number }
  | { kind: 'open-stage-log'; stage: StageKey }
  | { kind: 'resume-stage'; stage: 'uat' | 'review' | 'fix' }
  | { kind: 'open-full-evidence'; stage: InsideStageKey; processId: string };

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

**Interfaces:**
- Produces: `openProcessRun`, `finishProcessRun`, `listProcessRuns`, `ProcessRun`, `ProcessRunStatus`.
- Consumes: `Store`, ticket ids, optional `stage_runs.id`.

- [ ] **Step 1: Write failing migration and store tests**

Cover fresh DB creation, v25 → v26 migration, immutable identity snapshots, status transitions, and ticket-scoped ordering. The mutation each test catches is a missing table/index, an overwritten provider/model snapshot, or a cross-ticket read.

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
  stage_run_id  INTEGER REFERENCES stage_runs(id),
  agent_name    TEXT,
  provider      TEXT,
  model         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running','passed','failed','interrupted','stale')),
  result_kind   TEXT,
  artifact_path TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_process_runs_ticket
  ON process_runs(ticket_id, stage_key, process_id, id);
```

Increment `SCHEMA_VERSION` to 26, mirror the table in both fresh schema and migration, and do not backfill historical AI identity.

- [ ] **Step 4: Implement positional-parameter store APIs**

Use `store.db.prepare(sql).get/all/run` with positional `?` parameters only so the Node built-in SQLite CLI path remains compatible.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/store/db.test.ts src/store/processRuns.test.ts`
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

Seed a second `estimated = 1` row and prove it is excluded from the recorded summary. Seed legacy null-linked rows and prove normal ticket-level queries still return them.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/tokenUsage.test.ts src/store/reviewFindings.test.ts src/agent/instrumentedAdapter.test.ts`
Expected: FAIL because process linkage and recorded-only aggregation are absent.

- [ ] **Step 3: Add nullable linkage columns and indexes**

```sql
ALTER TABLE token_usage ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id);
ALTER TABLE review_findings ADD COLUMN process_run_id INTEGER REFERENCES process_runs(id);
CREATE INDEX IF NOT EXISTS idx_token_usage_process ON token_usage(process_run_id, id);
CREATE INDEX IF NOT EXISTS idx_review_findings_process ON review_findings(process_run_id, id);
```

Increment `SCHEMA_VERSION` to 27. Guard the migration with `tableColumns`; fresh schema includes the columns directly. Do not assign legacy rows to invented runs.

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

Run: `npx vitest run src/store/tokenUsage.test.ts src/store/reviewFindings.test.ts src/agent/instrumentedAdapter.test.ts src/workflow/tokenUsageAttribution.test.ts`
Expected: PASS.
Commit: `feat: attribute recorded tokens to inside processes`

### Task 4: Add Stable Implementation Runs and Provider Segments

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/implementationRuns.ts`
- Create: `src/store/implementationRuns.test.ts`
- Modify: `src/store/phaseMarks.ts`
- Modify: `src/store/phaseMarks.test.ts`
- Modify: `src/agent/sessionSwitch.ts`
- Modify: `src/agent/sessionSwitch.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `openImplementationRun`, `openImplementationSegment`, `confirmImplementationSegment`, `closeImplementationSegment`, `listImplementationTimeline`.
- Consumes: provider `SessionStart` as confirmation; switch flow records pending intent but not a started segment.

- [ ] **Step 1: Write failing same-run/multiple-segment tests**

```ts
expect(timeline.run.id).toBe(stableRunId);
expect(timeline.segments.map((s) => [s.provider, s.model])).toEqual([
  ['claude', 'opus'],
  ['codex', 'sol'],
]);
expect(timeline.segments[1]!.providerSessionId).toBe('codex-session-2');
```

Also prove that a cancelled/failed terminal launch creates no confirmed segment and that legacy phase marks keep null segment linkage.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/implementationRuns.test.ts src/agent/sessionSwitch.test.ts src/hooks/dispatch.test.ts src/store/phaseMarks.test.ts`
Expected: FAIL because stable implementation runs and segments are absent.

- [ ] **Step 3: Add implementation run/segment schema**

```sql
CREATE TABLE IF NOT EXISTS implementation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
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
```

Increment `SCHEMA_VERSION` to 28. Add nullable `implementation_run_id` and `implementation_segment_id` to `phase_marks`, add nullable `implementation_segment_id` to `token_usage`, and create an index on `token_usage(implementation_segment_id, id)`. Legacy rows keep null links.

- [ ] **Step 4: Record only confirmed provider sessions**

The switch flow creates a pending switch intent after confirmation. `hooks/dispatch.ts` confirms the segment when the matching new provider emits `SessionStart`, closes the previous segment, and preserves the stable Karst run id. Never pretend provider session ids are shared across cores.

- [ ] **Step 5: Keep Implementation tokens absent**

Do not synthesize token values for interactive sessions in this task. Add a reducer test asserting that a segment without measured usage omits `tokens` rather than returning total `0`; Task 5 adds the measured ingestion seam.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/store/implementationRuns.test.ts src/agent/sessionSwitch.test.ts src/hooks/dispatch.test.ts src/store/phaseMarks.test.ts`
Expected: PASS.
Commit: `feat: preserve implementation agent switch history`

### Task 5: Ingest Measured Interactive Token Deltas

**Files:**
- Create: `src/agent/interactiveUsage.ts`
- Create: `src/agent/interactiveUsage.test.ts`
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/db.test.ts`
- Modify: `src/agent/aiCallSites.ts`
- Modify: `src/hooks/endpoint.ts`
- Modify: `src/hooks/endpoint.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`
- Modify: `src/store/tokenUsage.ts`
- Modify: `src/store/tokenUsage.test.ts`
- Modify: `src/agent/provider.ts`

**Interfaces:**
- Produces: `InteractiveUsageSample`, `interactiveUsageDelta`, and closed `UsageUpdate` hook handling linked to `implementation_segment_id`.
- Consumes: provider-reported numeric cumulative usage only; payloads without authoritative counts produce no row.

- [ ] **Step 1: Write failing delta and validation tests**

```ts
expect(interactiveUsageDelta(
  { input: 1_000, output: 200, cachedInput: 100 },
  { input: 1_450, output: 320, cachedInput: 180 },
)).toEqual({ input: 450, output: 120, cachedInput: 80, total: 650 });
```

Cover first sample, repeated cumulative sample, negative/reset counters, non-numeric fields, wrong provider/session, stale segment, and duplicate event id. A reset starts a new baseline and records no negative delta.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/agent/interactiveUsage.test.ts src/hooks/endpoint.test.ts src/hooks/dispatch.test.ts src/store/tokenUsage.test.ts`
Expected: FAIL because no interactive-usage event or segment-linked token writer exists.

- [ ] **Step 3: Add a closed usage event contract**

```ts
export interface InteractiveUsageSample {
  eventId: string;
  provider: AgentProvider;
  providerSessionId: string;
  input: number;
  output: number;
  cachedInput?: number;
  observedAt: string;
}
```

The installed provider bridge may emit `UsageUpdate` only from authoritative CLI fields. It must never estimate from transcript size, terminal text, elapsed time, or model output.

- [ ] **Step 4: Persist per-segment deltas**

Increment `SCHEMA_VERSION` to 29 and add nullable `source_event_id` plus a partial unique index for non-null event ids to `token_usage`. Resolve the confirmed implementation segment by provider session id, deduplicate `eventId`, calculate the delta from the last accepted cumulative sample, and write `token_usage(call_site='implementation', estimated=0, implementation_segment_id=..., source_event_id=...)`. Add `implementation` to the closed AI call-site set and use the schema-v28 segment linkage from Task 4.

- [ ] **Step 5: Preserve absence for unsupported providers**

When a provider exposes no authoritative usage fields, its bridge emits no `UsageUpdate`; the segment remains token-absent. Add a capability result to `provider.ts` so reducers can distinguish “not measured” from a measured zero without inventing a count.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/agent/interactiveUsage.test.ts src/hooks/endpoint.test.ts src/hooks/dispatch.test.ts src/store/tokenUsage.test.ts src/workflow/tokenUsageAttribution.test.ts`
Expected: PASS.
Commit: `feat: record measured implementation token deltas`

### Task 6: Persist Causal Recovery Rounds and Cap Snapshots

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/recoveryRounds.ts`
- Create: `src/store/recoveryRounds.test.ts`
- Modify: `src/workflow/gates/commit.ts`
- Create: `src/workflow/gates/commit.test.ts`
- Modify: `src/workflow/fixAttempts.ts`
- Modify: `src/workflow/fixAttempts.test.ts`
- Modify: `src/workflow/stages/fix.ts`
- Modify: `src/workflow/stages/fix.test.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/workflow/driveTicket.test.ts`

**Interfaces:**
- Produces: `openRecoveryRound`, `attachFixExecution`, `finishRecoveryRound`, `activeRecoverySeries`, `recoveryDecision`.
- Consumes: deterministic failing gate/Tester/Review result and the manifest cap only when the first round opens.

- [ ] **Step 1: Write failing historical-stability tests**

```ts
expect(activeRecoverySeries(store, ticketId, 'review')?.maxRounds).toBe(2);
manifest.review!.maxFixAttempts = 5;
expect(recoveryDecision(store, ticketId, 'review').maxRounds).toBe(2);
```

Add cases for source process identity, round ordering, exhaustion, a Fix process-run link, and an execution crash that creates no recovery round.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/workflow/fixAttempts.test.ts src/workflow/driveTicket.test.ts src/workflow/stages/fix.test.ts`
Expected: FAIL because recovery evidence and snapshotted policy are absent.

- [ ] **Step 3: Add recovery evidence schema**

```sql
CREATE TABLE IF NOT EXISTS recovery_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  source_stage TEXT NOT NULL CHECK (source_stage IN ('uat','review')),
  source_process_id TEXT NOT NULL,
  source_run_id INTEGER,
  trigger_kind TEXT NOT NULL,
  trigger_detail TEXT NOT NULL,
  round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  fix_process_run_id INTEGER REFERENCES process_runs(id),
  revalidation_stage_run_id INTEGER REFERENCES stage_runs(id),
  status TEXT NOT NULL CHECK (status IN ('pending','fixing','revalidating','passed','failed','exhausted','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_round
  ON recovery_rounds(ticket_id, source_stage, round);
```

Increment `SCHEMA_VERSION` to 30 and mirror the table/index in the fresh schema.

- [ ] **Step 4: Open the round with the failing outcome transaction**

Extend `commitGateOutcome`'s premutation so the failing verdict and new recovery row share one transaction. Subsequent driver decisions read `max_rounds` from the active series rather than the live manifest.

- [ ] **Step 5: Link Fix and revalidation evidence**

Open a `process_runs(process_id='fix')` row before the `fix-resume` call, use tracking `processRunId`, attach it to the recovery round, and link the next UAT/Review `stage_run_id` as revalidation.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/store/recoveryRounds.test.ts src/workflow/gates/commit.test.ts src/workflow/fixAttempts.test.ts src/workflow/driveTicket.test.ts src/workflow/stages/fix.test.ts`
Expected: PASS.
Commit: `feat: persist causal recovery rounds`

### Task 7: Add Process Assignment Configuration and Snapshots

**Files:**
- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/validate/uat.ts`
- Modify: `src/manifest/validate/review.ts`
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

Prove invalid providers/models are named manifest errors, defaults resolve when config is absent, and a later Settings edit does not mutate an already stored `process_runs` row.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/agent/processAssignment.test.ts src/ui/settings/webview.test.ts`
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

- [ ] **Step 4: Add tab-scoped Settings fields**

Add `processes` to the Agents section's `SECTION_FIELDS`, render five process assignment rows on the Agents tab, and spread the existing `processes` object on save so hidden/future entries survive. Recovery limits remain under the Quality section's existing `uat`/`review` ownership. Mirror closed provider/model choices from host-supplied catalogs, not HTML literals.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/writeManifest.test.ts src/agent/processAssignment.test.ts src/ui/settings/webview.test.ts`
Expected: PASS.
Commit: `feat: configure inside ai process assignments`

### Task 8: Implement UAT Tester and Explicit Review Execution Outcomes

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Create: `src/store/uatFindings.ts`
- Create: `src/store/uatFindings.test.ts`
- Create: `src/workflow/uat/tester.ts`
- Create: `src/workflow/uat/tester.test.ts`
- Modify: `src/workflow/stages/uat.ts`
- Modify: `src/workflow/stages/uat.test.ts`
- Modify: `src/workflow/review/findingsLane.ts`
- Modify: `src/workflow/review/findingsLane.test.ts`
- Modify: `src/workflow/stages/review.ts`
- Modify: `src/workflow/stages/review.test.ts`
- Modify: `src/agent/aiCallSites.ts`

**Interfaces:**
- Produces: `runUatTester`, `TesterResult`, explicit Review process outcomes `validated | blocking | execution-failed | interrupted`.
- Consumes: resolved assignment snapshot, target list, `processRunId`, and the instrumented adapter.

- [ ] **Step 1: Write failing Tester tests**

```ts
expect(await runUatTester(input, deps)).toEqual({ kind: 'blocking', findingIds: [1, 2] });
expect(listProcessRuns(store, ticketId)[0]).toMatchObject({ processId: 'tester', resultKind: 'blocking' });
```

Cover pass, blocking findings, malformed output, adapter crash, cancellation, target linkage, and `uat-tester` token attribution.

- [ ] **Step 2: Write failing Review crash-vs-finding tests**

Prove blocking validated findings create recovery, while an adapter crash records `execution-failed`, exposes the artifact, and does not increment recovery rounds.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts`
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

Increment `SCHEMA_VERSION` to 31 and mirror the table/index in the fresh schema.

Parse bounded structured JSON using the same untrusted-prose collapsing and file validation principles as Review findings.

- [ ] **Step 5: Orchestrate Gates → Services context → Tester**

Gates keep deterministic exit-code semantics. Services contributes host-known read-only context. Tester runs only after required gates pass; a validated blocking result creates recovery, while execution failure parks/retries without consuming a Fix round.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/store/uatFindings.test.ts src/workflow/uat/tester.test.ts src/workflow/stages/uat.test.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.test.ts`
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
- Produces: `openShipRun`, `openShipRepoStep`, `finishShipRepoStep`, `recordShipCommit`, `listShipEvidence`; richer Git probes `workingTreeSummary`, `listCommitsFrom`, `headCommit`.
- Consumes: existing PR/current merge checks and the `pr-description` process run.

- [ ] **Step 1: Write failing persistence/restart tests**

```ts
expect(listShipEvidence(store, ticketId).repos.web).toMatchObject({
  push: { status: 'passed' },
  pr: { existedBeforeShip: false, number: 413 },
});
expect(listShipEvidence(store, ticketId).repos.api.commits[0]).toMatchObject({ origin: 'before-ship' });
```

Cover partial success, adopted PR, existing human description preservation, created commit SHA, push failure, host restart after Git/GitHub effect but before result write, and rerun reconciliation.

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
  process_run_id INTEGER REFERENCES process_runs(id),
  started_at TEXT NOT NULL,
  ended_at TEXT
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

Increment `SCHEMA_VERSION` to 32 and mirror all three tables/indexes in the fresh schema.

- [ ] **Step 4: Write before/after evidence around every external operation**

Open each step as `running`, perform or re-probe the operation, then record `passed | failed | note`. A retry first inspects current Git/GitHub state and reconciles an interrupted row; it does not blindly repeat commit, push, body update, or PR creation.

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

Cover gate-triggered and Tester-triggered UAT Fix, Review gate/finding Fix, no Fix without recovery evidence, execution crash without a round, exhaustion without an extra Fix row, stored max stability, stale `stage_runs`, and settings-vs-recorded identity.

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
expect(doneReceipt({ stageCurrent: 'ship', evidence })).toBeNull();
expect(doneReceipt({ stageCurrent: 'done', evidence })?.tokens.label).toContain('recorded');
```

Prove merged PRs only, final gate wording, recovery history, Ship-created commits, role breakdown, exclusion of estimated tokens, and omission of unknown legacy facts.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/model/inside/ship.test.ts src/model/inside/done.test.ts src/model/inside/index.test.ts src/store/tokenUsage.test.ts`
Expected: FAIL because Ship provenance and Done receipt reducers do not exist.

- [ ] **Step 4: Implement current-state and historical separation**

PR/Merge reducers use current `prs`/`merge_checks`; commit/push/description provenance uses append-only Ship evidence. Done returns a pending receipt view until the ticket actually enters `done` and never treats estimated token rows as recorded.

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
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`
- Modify: `src/workflow/gates/runList.ts`
- Modify: `src/workflow/gates/runList.test.ts`
- Modify: `src/workflow/stages/ship.ts`
- Modify: `src/workflow/driveTicket.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `InsideProgressEvent`, `LiveOperationView`, closed navigation-action messages.
- Consumes: all store readers once per dashboard snapshot and preformatted host reducers.

- [ ] **Step 1: Write failing snapshot/projection tests**

Prove `stageCurrent='fix'` selects the causal UAT/Review presentation, `DashboardState.inside` excludes a peer Fix stage, and every store source is read into the reducer exactly once.

- [ ] **Step 2: Write failing protocol tests**

```ts
expect(parseDashboardMessage({ type: 'inside-action', action: { kind: 'open-pr', repo: '/web', number: 413 } })).toEqual(/* validated action */);
```

Cover invalid path/line/number/process ids, host-owned targets, action-result lifecycle, and a generic live event replacing webview-derived Ship steps.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/workflow/gates/runList.test.ts`
Expected: FAIL because richer state and protocol variants are absent.

- [ ] **Step 4: Emit started and finished live events**

```ts
export interface InsideProgressEvent {
  ticketId: number;
  stage: InsideStageKey;
  processId: string;
  status: 'run' | 'wait' | 'fail';
  main: string;
  detail?: string;
  duration?: string;
  execution?: AgentExecutionView;
}
```

Gate runners emit before start and after completion. Review findings, Tester, Fix, and Ship translate their progress into the same host-owned shape. The webview overlays only the supplied view.

- [ ] **Step 5: Route typed actions**

Resolve PR, commit, file, artifact, resume, and full-evidence actions in the host. Keep arbitrary filesystem paths and URLs out of the untrusted message boundary wherever repo/id lookup can resolve them.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts src/workflow/gates/runList.test.ts src/workflow/stages/ship.test.ts`
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

**Interfaces:**
- Produces: deterministic fixture matrix for 2/5/10/15/20 repositories and all live/error states.
- Consumes: production `InsideStageView` shapes; fixture data never enters extension runtime.

- [ ] **Step 1: Write failing scale and compact-contract tests**

Prove top-level process count is constant at every repo size, `remaining` is exact, no untrusted value enters HTML unescaped, compact metadata stays attached to its process, and every interactive object is keyboard-semantic.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/ui/dashboard/insideFixtures.test.ts src/ui/dashboard/webview.test.ts`
Expected: FAIL until the fixture matrix and compact container rules exist.

- [ ] **Step 3: Add container-responsive layout**

Set container context on Inside and use token-backed compact layouts at supported widths. Preserve status/name first, move agent/token metadata to a second line, keep the same timeline rail cell, wrap PR branches, and prohibit whole-component horizontal scrolling.

- [ ] **Step 4: Perform manual Extension Dev Host verification**

Run: `npm run dev:extension` and inspect 300px, 360px, 430px, and normal dashboard widths with 2/5/10/15/20-repo fixtures. Verify keyboard disclosure navigation, nested actions, focus visibility, reduced motion, long names/paths, and current-operation updates. Record screenshots or notes in the PR description; do not commit generated screenshots unless requested.

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
| Measured Implementation token attribution and truthful absence | 4–5, 10, 12 |
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
