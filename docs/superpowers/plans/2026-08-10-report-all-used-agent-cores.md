# Include ALL Used Agent Cores in the Issue Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the karst issue report's metadata preview and review popup carry per-core evidence for every agent core actually used on a ticket (headless calls, interactive usage, confirmed sessions, models), instead of only the codex bridge log, including after a mid-session core switch.

**Architecture:** Add a new `cores` diagnostic metadata section aggregated in `src/diagnostics/storeEvidence.ts` from three append-only per-ticket sources — `token_usage` (provider/model/tokens per headless AI call), `interactive_usage_samples` (per interactive usage observation, joined through `process_runs`), and `session_launch_intents` (per prepared launch, `status='confirmed'` counts as a session). Because every source is written when the event happens, a core switched mid-session leaves its rows in place and the section reports every core. The new section flows through the existing pipeline untouched: `collectMetadata` → `finalize` (SECTION_NAMES) → markdown render (generic) → review popup (`buildReviewSummary`) and GitHub prefill (`issuePrefill`) via a new `coreLines` helper.

**Tech Stack:** TypeScript, better-sqlite3 (positional `?` binds only), vitest.

## Global Constraints

- `src/diagnostics/` must stay host-agnostic: no `vscode`, `child_process`, `node:http`, or `src/workflow/`/`src/hooks/`/`src/gh/` imports (`src/diagnostics/nonInterference.test.ts` guards this). New reads are `SELECT` only.
- Store readers use `store.db.prepare(sql).get/all/run` with positional `?` only — no named params, no `.pluck()`.
- Strict TDD: write the failing test, run it (RED), implement (GREEN), commit.
- Conventional commits; small files (<400 lines); keep this plan's added code in existing files.
- Debug logging: the `cores` collector is a read-only diagnostic path like the other collectors — no new injected debug callback needed; follow the existing `catch { return { status: 'unavailable', reason: 'reader_failed' } }` pattern.
- A provider value that is `NULL` (legacy/unattributed call) is bucketed as `'unknown'` — visible, never dropped.
- `sessions` counts ONLY `status = 'confirmed'` launch intents; `pending`/`failed`/`superseded` are not sessions.

---

### Task 1: Per-core usage reader in `storeEvidence.ts`

**Files:**
- Modify: `src/diagnostics/storeEvidence.ts` (append after `readMergeChecks`)
- Test: `src/diagnostics/storeEvidence.test.ts` (append to the describe block)

**Interfaces:**
- Consumes: `Store` from `../store/db.js` (existing), `BoundedRows<T>` (existing in this file)
- Produces:
  - `CoreUsageTokens { input: number; output: number; total: number }`
  - `CoreUsageEvidence { core: string; headlessCalls: number; headlessTokens: CoreUsageTokens; interactiveCalls: number; interactiveTokens: CoreUsageTokens; sessions: number; models: readonly string[]; firstSeenAt: string | null; lastSeenAt: string | null }`
  - `CoreUsageScope = { readonly ticketId: number } | { readonly projectId: number }`
  - `readCoreUsage(store: Store, scope: CoreUsageScope, cap: number): BoundedRows<CoreUsageEvidence>`
  - `readCoreUsage` is consumed by Task 2 as `readCoreUsage(input.store, { ticketId: input.ticketId }, DIAGNOSTIC_LIMITS.maxRowsPerSection)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/diagnostics/storeEvidence.test.ts` inside the existing `describe('diagnostic store evidence', ...)` block:

```ts
function seedUsageEvidence(store: Store, ticketId: number): void {
  store.db.prepare(
    `INSERT INTO token_usage
      (ticket_id, call_site, provider, model, input_tokens, output_tokens,
       total_tokens, estimated, outcome, recorded_at)
     VALUES (?, 'uat-tester', 'codex', 'gpt-5-codex', 100, 40, 140, 0, 'ok', '2026-07-28T09:00:00.000Z'),
            (?, 'uat-tester', 'codex', 'gpt-5-codex', 200, 60, 260, 0, 'ok', '2026-07-28T10:00:00.000Z'),
            (?, 'pr-description', 'claude', 'opus', 30, 10, 40, 0, 'ok', '2026-07-29T08:00:00.000Z'),
            (?, 'ticket-analysis', NULL, NULL, 5, 1, 6, 0, 'ok', '2026-07-29T09:00:00.000Z')`,
  ).run(ticketId, ticketId, ticketId, ticketId)
  store.db.prepare(
    `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
     VALUES (?, 'impl', 'session', 1, 'passed', '2026-07-28T08:00:00.000Z')`,
  ).run(ticketId)
  const processId = (store.db.prepare('SELECT id FROM process_runs WHERE ticket_id = ?').get(ticketId) as { id: number }).id
  store.db.prepare(
    `INSERT INTO interactive_usage_samples
      (process_run_id, source_event_id, provider, provider_session_id,
       input_tokens, output_tokens, total_tokens, baseline_only, observed_at)
     VALUES (?, 'ev-1', 'codex', 'sess-codex', 500, 200, 700, 0, '2026-07-28T11:00:00.000Z'),
            (?, 'ev-2', 'codex', 'sess-codex', 300, 100, 400, 0, '2026-07-28T12:00:00.000Z')`,
  ).run(processId, processId)
  store.db.prepare(
    `INSERT INTO session_launch_intents
      (ticket_id, launch_id, purpose, provider, model, reason, session_origin, status, created_at, resolved_at)
     VALUES (?, 'launch-a', 'implementation', 'codex', 'gpt-5-codex', 'open', 'new', 'confirmed', '2026-07-28T08:00:00.000Z', '2026-07-28T08:01:00.000Z'),
            (?, 'launch-b', 'implementation', 'claude', 'opus', 'switch', 'new', 'confirmed', '2026-07-29T08:00:00.000Z', '2026-07-29T08:01:00.000Z'),
            (?, 'launch-c', 'implementation', 'codex', 'gpt-5-codex', 'retry', 'new', 'failed', '2026-07-29T09:00:00.000Z', '2026-07-29T09:01:00.000Z')`,
  ).run(ticketId, ticketId, ticketId)
}

it('aggregates per-core usage from token_usage, interactive samples and confirmed launches', () => {
  store = openStore(':memory:')
  const project = upsertProject(store, { slug: 'p' })
  const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
  seedUsageEvidence(store, ticket.id)

  const result = readCoreUsage(store, { ticketId: ticket.id }, 10)
  const byCore = new Map(result.rows.map((row) => [row.core, row]))
  expect(byCore.get('codex')).toMatchObject({
    core: 'codex',
    headlessCalls: 2,
    headlessTokens: { input: 300, output: 100, total: 400 },
    interactiveCalls: 2,
    interactiveTokens: { input: 800, output: 300, total: 1100 },
    sessions: 1, // the 'failed' launch is not a session
    models: ['gpt-5-codex'],
    firstSeenAt: '2026-07-28T09:00:00.000Z',
    lastSeenAt: '2026-07-28T12:00:00.000Z',
  })
  expect(byCore.get('claude')).toMatchObject({
    core: 'claude',
    headlessCalls: 1,
    headlessTokens: { input: 30, output: 10, total: 40 },
    interactiveCalls: 0,
    interactiveTokens: { input: 0, output: 0, total: 0 },
    sessions: 1,
    models: ['opus'],
  })
  // NULL provider rows stay visible under 'unknown' — never dropped.
  expect(byCore.get('unknown')).toMatchObject({
    core: 'unknown',
    headlessCalls: 1,
    headlessTokens: { input: 5, output: 1, total: 6 },
  })
  expect(result.omitted).toBe(0)
})

it('scopes readCoreUsage to the ticket or project and caps rows', () => {
  store = openStore(':memory:')
  const project = upsertProject(store, { slug: 'p' })
  const other = upsertProject(store, { slug: 'q' })
  const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
  const otherTicket = createTicket(store, { projectId: other.id, key: 'K-2', title: 't2' })
  seedUsageEvidence(store, ticket.id)
  seedUsageEvidence(store, otherTicket.id)

  const scoped = readCoreUsage(store, { ticketId: ticket.id }, 10)
  expect(scoped.rows.length).toBe(3)
  expect(scoped.rows.map((row) => row.core).sort()).toEqual(['claude', 'codex', 'unknown'])

  const projectWide = readCoreUsage(store, { projectId: project.id }, 10)
  expect(projectWide.rows.length).toBe(3)
  expect(readCoreUsage(store, { projectId: other.id }, 10).rows.map((row) => row.core).sort()).toEqual(
    ['claude', 'codex', 'unknown'],
  )
  expect(readCoreUsage(store, { ticketId: ticket.id }, 2).omitted).toBe(1)
  expect(readCoreUsage(store, { ticketId: 99999 }, 10).rows).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diagnostics/storeEvidence.test.ts`
Expected: FAIL — `readCoreUsage` is not exported.

- [ ] **Step 3: Implement `readCoreUsage`**

Append to `src/diagnostics/storeEvidence.ts`:

```ts
export interface CoreUsageTokens {
  readonly input: number
  readonly output: number
  readonly total: number
}

export interface CoreUsageEvidence {
  readonly core: string
  readonly headlessCalls: number
  readonly headlessTokens: CoreUsageTokens
  readonly interactiveCalls: number
  readonly interactiveTokens: CoreUsageTokens
  readonly sessions: number
  readonly models: readonly string[]
  readonly firstSeenAt: string | null
  readonly lastSeenAt: string | null
}

export type CoreUsageScope = { readonly ticketId: number } | { readonly projectId: number }

interface CoreTotalsRow {
  core: string
  calls: number
  input: number
  output: number
  total: number
  first_at: string | null
  last_at: string | null
}

function zeroTokens(): CoreUsageTokens {
  return { input: 0, output: 0, total: 0 }
}

/**
 * Per-core usage evidence for the report's `cores` section. Three append-only
 * sources, merged by provider:
 *
 *  - `token_usage` — every headless AI call (provider, model, tokens);
 *  - `interactive_usage_samples` — every interactive usage observation, joined
 *    through `process_runs` for the ticket scope;
 *  - `session_launch_intents` — every prepared launch; only `confirmed` rows
 *    count as sessions.
 *
 * All three are written at the moment the event happens, so a mid-session core
 * switch leaves every earlier core's rows in place — the report describes all
 * used cores, never just the latest `tickets.session_provider`.
 */
export function readCoreUsage(
  store: Store,
  scope: CoreUsageScope,
  cap: number,
): BoundedRows<CoreUsageEvidence> {
  const limit = checkedCap(cap)
  const ticketClause = 'ticket_id = ?'
  const projectClause = 'project_id = ?'
  const params: number[] = 'ticketId' in scope ? [scope.ticketId] : [scope.projectId]
  const ticketWhere = 'ticketId' in scope ? `${ticketClause} AND s.process_run_id IN (SELECT id FROM process_runs WHERE ticket_id = ?)` : undefined

  const headlessRows = store.db.prepare(
    `SELECT COALESCE(provider, 'unknown') AS core,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(total_tokens), 0) AS total,
            MIN(recorded_at) AS first_at,
            MAX(recorded_at) AS last_at
       FROM token_usage
      WHERE ${'ticketId' in scope ? ticketClause : projectClause}
      GROUP BY COALESCE(provider, 'unknown')`,
  ).all(...params) as CoreTotalsRow[]

  const interactiveRows = store.db.prepare(
    `SELECT s.provider AS core,
            COUNT(*) AS calls,
            COALESCE(SUM(s.input_tokens), 0) AS input,
            COALESCE(SUM(s.output_tokens), 0) AS output,
            COALESCE(SUM(s.total_tokens),
                     COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0)) AS total,
            MIN(s.observed_at) AS first_at,
            MAX(s.observed_at) AS last_at
       FROM interactive_usage_samples s
       JOIN process_runs p ON p.id = s.process_run_id
       ${'ticketId' in scope ? 'WHERE p.ticket_id = ?' : 'JOIN tickets t ON t.id = p.ticket_id WHERE t.project_id = ?'}
      GROUP BY s.provider`,
  ).all(...params) as CoreTotalsRow[]

  const sessionRows = store.db.prepare(
    `SELECT i.provider AS core,
            COUNT(*) AS calls,
            MIN(i.created_at) AS first_at,
            MAX(i.created_at) AS last_at
       FROM session_launch_intents i
       ${'ticketId' in scope ? 'WHERE i.ticket_id = ? AND i.status = ?' : 'JOIN tickets t ON t.id = i.ticket_id WHERE t.project_id = ? AND i.status = ?'}
      GROUP BY i.provider`,
  ).all(...params, 'confirmed') as CoreTotalsRow[]

  const modelRows = store.db.prepare(
    `SELECT provider AS core, model
       FROM token_usage
      WHERE ${'ticketId' in scope ? ticketClause : projectClause}
        AND provider IS NOT NULL AND model IS NOT NULL AND model <> ''
      GROUP BY provider, model
      ORDER BY provider ASC, model ASC`,
  ).all(...params) as Array<{ core: string; model: string }>

  const byCore = new Map<string, CoreUsageEvidence>()
  const modelSets = new Map<string, Set<string>>()
  for (const row of modelRows) {
    const set = modelSets.get(row.core) ?? new Set<string>()
    set.add(row.model)
    modelSets.set(row.core, set)
  }
  const hold = (core: string): CoreUsageEvidence => {
    const existing = byCore.get(core)
    if (existing) return existing
    const held: CoreUsageEvidence = {
      core,
      headlessCalls: 0,
      headlessTokens: zeroTokens(),
      interactiveCalls: 0,
      interactiveTokens: zeroTokens(),
      sessions: 0,
      models: [],
      firstSeenAt: null,
      lastSeenAt: null,
    }
    byCore.set(core, held)
    return held
  }
  const absorb = (held: CoreUsageEvidence, row: CoreTotalsRow, field: 'headless' | 'interactive'): void => {
    if (field === 'headless') held.headlessCalls += row.calls
    else held.interactiveCalls += row.calls
    const tokens = field === 'headless' ? held.headlessTokens : held.interactiveTokens
    tokens.input += row.input
    tokens.output += row.output
    tokens.total += row.total
    const seen = [held.firstSeenAt, row.first_at].filter((v): v is string => v !== null)
    held.firstSeenAt = seen.length > 0 ? seen.reduce((a, b) => (a < b ? a : b)) : null
    const last = [held.lastSeenAt, row.last_at].filter((v): v is string => v !== null)
    held.lastSeenAt = last.length > 0 ? last.reduce((a, b) => (a > b ? a : b)) : null
  }
  for (const row of headlessRows) absorb(hold(row.core), row, 'headless')
  for (const row of interactiveRows) absorb(hold(row.core), row, 'interactive')
  for (const row of sessionRows) {
    const held = hold(row.core)
    held.sessions += row.calls
    const seen = [held.firstSeenAt, row.first_at].filter((v): v is string => v !== null)
    held.firstSeenAt = seen.length > 0 ? seen.reduce((a, b) => (a < b ? a : b)) : null
    const last = [held.lastSeenAt, row.last_at].filter((v): v is string => v !== null)
    held.lastSeenAt = last.length > 0 ? last.reduce((a, b) => (a > b ? a : b)) : null
  }
  for (const [core, models] of modelSets) hold(core).models = [...models]

  const rows = [...byCore.values()]
    .sort((a, b) =>
      b.headlessTokens.total + b.interactiveTokens.total - a.headlessTokens.total - a.interactiveTokens.total
      || (a.core < b.core ? -1 : a.core > b.core ? 1 : 0))
  const kept = rows.slice(0, limit)
  return {
    rows: kept,
    omitted: rows.length > limit ? rows.length - limit : 0,
  }
}
```

Note: `checkedCap` is already defined in this file (Task 1 reuses it). `CoreTotalsRow.calls` is `number`; the `interactive` WHERE uses `p.ticket_id = ?` while the shared `params` holds the single scope id — bind order is `[scopeId, 'confirmed']` for sessions and `[scopeId]` for the rest, matching the SQL above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diagnostics/storeEvidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole diagnostics suite to catch regressions**

Run: `npx vitest run src/diagnostics`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/storeEvidence.ts src/diagnostics/storeEvidence.test.ts
git commit -m "feat(diagnostics): per-core usage evidence reader for issue reports"
```

---

### Task 2: `cores` metadata section in `collectMetadata`

**Files:**
- Modify: `src/diagnostics/types.ts` (`DiagnosticSectionName`)
- Modify: `src/diagnostics/finalize.ts` (`SECTION_NAMES`)
- Modify: `src/diagnostics/collectMetadata.ts` (import + two call sites + `collectCores`)
- Test: `src/diagnostics/collectMetadata.test.ts` (new test)
- Test: `src/diagnostics/finalize.test.ts` (accepts the new section)

**Interfaces:**
- Consumes: `readCoreUsage` + `CoreUsageEvidence` from `./storeEvidence.js` (Task 1); `DIAGNOSTIC_LIMITS.maxRowsPerSection`; `SafeText` from `./hostEvidence.js` (already used in this file)
- Produces: `metadata.cores: DiagnosticSection` — `available`/`truncated` with `data` as an array of `{ core, headlessCalls, headlessTokens, interactiveCalls, interactiveTokens, sessions, models, firstSeenAt, lastSeenAt }`; `unavailable` with `reason: 'reader_failed'` on a read throw.

- [ ] **Step 1: Write the failing tests**

Append to `src/diagnostics/collectMetadata.test.ts`:

```ts
it('reports every agent core used on the ticket, including after a mid-session switch', async () => {
  store = openStore(':memory:')
  const localStore = store
  const project = upsertProject(localStore, { slug: 'one' })
  const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
  // Session A ran on codex; the ticket then switched mid-session to claude.
  // Both cores' rows are append-only evidence and must both appear.
  localStore.db.prepare(
    `INSERT INTO token_usage
      (ticket_id, call_site, provider, model, input_tokens, output_tokens,
       total_tokens, estimated, outcome, recorded_at)
     VALUES (?, 'uat-tester', 'codex', 'gpt-5-codex', 100, 40, 140, 0, 'ok', '2026-07-28T09:00:00.000Z'),
            (?, 'pr-description', 'claude', 'opus', 30, 10, 40, 0, 'ok', '2026-07-29T08:00:00.000Z')`,
  ).run(ticket.id, ticket.id)
  localStore.db.prepare(
    `INSERT INTO session_launch_intents
      (ticket_id, launch_id, purpose, provider, model, reason, session_origin, status, created_at)
     VALUES (?, 'l-a', 'implementation', 'codex', 'gpt-5-codex', 'open', 'new', 'confirmed', '2026-07-28T08:00:00.000Z'),
            (?, 'l-b', 'implementation', 'claude', 'opus', 'switch', 'new', 'confirmed', '2026-07-29T08:00:00.000Z')`,
  ).run(ticket.id, ticket.id)

  const draft = await collectMetadata({
    store: localStore,
    project,
    manifest: manifest({}),
    ticketId: ticket.id,
    runtime: {
      extensionVersion: '1', editorVersion: '1', platform: 'darwin', arch: 'arm64',
      remoteNamePresent: false, uiKind: 'desktop', developmentMode: false,
    },
    logs: makeBoundedLogBuffer(),
    reportId: 'report-cores',
    generatedAt: '2026-07-28T00:00:00.000Z',
    aliases: createPseudonymizer(new Uint8Array(32).fill(5)),
  })

  const section = draft.metadata.cores
  expect(section?.status).toBe('available')
  const rows = (section as { data: unknown[] }).data as Record<string, unknown>[]
  const byCore = new Map(rows.map((row) => [row.core as string, row]))
  expect(byCore.get('codex')).toMatchObject({
    core: 'codex',
    headlessCalls: 1,
    headlessTokens: { input: 100, output: 40, total: 140 },
    sessions: 1,
    models: ['gpt-5-codex'],
  })
  expect(byCore.get('claude')).toMatchObject({
    core: 'claude',
    headlessCalls: 1,
    headlessTokens: { input: 30, output: 10, total: 40 },
    sessions: 1,
    models: ['opus'],
  })
  // A finalized report accepts the new section.
  expect(() => finalizeReport({ ...draft, contextStatus: 'declined' })).not.toThrow()
})

it('marks cores unavailable when its reader fails and finalizes', async () => {
  store = openStore(':memory:')
  const localStore = store
  const project = upsertProject(localStore, { slug: 'one' })
  const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
  const originalPrepare = localStore.db.prepare.bind(localStore.db)
  const failingStore = {
    ...localStore,
    db: new Proxy(localStore.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (/\bFROM\s+token_usage\b/i.test(sql)) throw new Error('PRIVATE_CORES_FAILURE')
          return originalPrepare(sql)
        }
      },
    }),
  } as Store
  const draft = await collectMetadata({
    store: failingStore,
    project,
    manifest: manifest({}),
    ticketId: ticket.id,
    runtime: {
      extensionVersion: '1', editorVersion: '1', platform: 'darwin', arch: 'arm64',
      remoteNamePresent: false, uiKind: 'desktop', developmentMode: false,
    },
    logs: makeBoundedLogBuffer(),
    reportId: 'report-cores-fail',
    generatedAt: '2026-07-28T00:00:00.000Z',
    aliases: createPseudonymizer(new Uint8Array(32).fill(6)),
  })
  expect(draft.metadata.cores).toEqual({ status: 'unavailable', reason: 'reader_failed' })
  expect(JSON.stringify(draft)).not.toContain('PRIVATE_CORES_FAILURE')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diagnostics/collectMetadata.test.ts`
Expected: FAIL — `metadata.cores` is `undefined`; `finalizeReport` throws `Unknown diagnostic section: cores`.

- [ ] **Step 3: Add `'cores'` to the section name unions**

In `src/diagnostics/types.ts`, add `| 'cores'` after `| 'phaseMarks'` in `DiagnosticSectionName`.

In `src/diagnostics/finalize.ts`, add `'cores',` after `'phaseMarks',` in `SECTION_NAMES`.

- [ ] **Step 4: Collect the section**

In `src/diagnostics/collectMetadata.ts`:
- Extend the import from `./storeEvidence.js` with `readCoreUsage`.
- In `collectMetadata`, after the `pullRequest` line (`metadata.pullRequest = collectPullRequests(...)`) and before `metadata.logs = ...`, add:

```ts
await yieldToHost(input.isCancelled)
metadata.cores = collectCores(input, safe)
```

- In `collectProjectMetadata`, add to the `metadata:` object after `logs:`:

```ts
cores: collectCores({ ...input, ticketId: undefined } as never, safe),
```

  (see Step 5 for the actual implementation — this line is replaced below by `collectProjectCores(input, safe)`.)

- Append the collector function at the end of the file:

```ts
function collectCores(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  try {
    const result = readCoreUsage(
      input.store,
      { ticketId: input.ticketId },
      DIAGNOSTIC_LIMITS.maxRowsPerSection,
    )
    const data = result.rows.map((row) => ({
      core: row.core,
      headlessCalls: row.headlessCalls,
      headlessTokens: row.headlessTokens,
      interactiveCalls: row.interactiveCalls,
      interactiveTokens: row.interactiveTokens,
      sessions: row.sessions,
      models: row.models
        .map((model) => safe(model))
        .filter((model): model is string => model !== null),
      firstSeenAt: safe(row.firstSeenAt),
      lastSeenAt: safe(row.lastSeenAt),
    }))
    return result.omitted > 0
      ? {
        status: 'truncated',
        data: json(data),
        omitted: result.omitted,
        reason: 'rows',
      }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}
```

For `collectProjectMetadata` (no ticket), reuse the same shape with a project scope:

```ts
function collectProjectCores(
  input: Omit<MetadataSources, 'ticketId'>,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  try {
    const result = readCoreUsage(
      input.store,
      { projectId: input.project.id },
      DIAGNOSTIC_LIMITS.maxRowsPerSection,
    )
    const data = result.rows.map((row) => ({
      core: row.core,
      headlessCalls: row.headlessCalls,
      headlessTokens: row.headlessTokens,
      interactiveCalls: row.interactiveCalls,
      interactiveTokens: row.interactiveTokens,
      sessions: row.sessions,
      models: row.models
        .map((model) => safe(model))
        .filter((model): model is string => model !== null),
      firstSeenAt: safe(row.firstSeenAt),
      lastSeenAt: safe(row.lastSeenAt),
    }))
    return result.omitted > 0
      ? {
        status: 'truncated',
        data: json(data),
        omitted: result.omitted,
        reason: 'rows',
      }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}
```

And in `collectProjectMetadata`'s `metadata:` object, replace the `cores:` placeholder line from Step 4 with:

```ts
cores: collectProjectCores(input, safe),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/diagnostics/collectMetadata.test.ts src/diagnostics/finalize.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full diagnostics suite**

Run: `npx vitest run src/diagnostics`
Expected: PASS (the cancel test counts reads but only asserts reads stop at the first yield — the new section's own `await yieldToHost` keeps that invariant).

- [ ] **Step 7: Commit**

```bash
git add src/diagnostics/types.ts src/diagnostics/finalize.ts src/diagnostics/collectMetadata.ts src/diagnostics/collectMetadata.test.ts
git commit -m "feat(diagnostics): report per-core usage evidence for every used agent core"
```

---

### Task 3: Surface per-core lines in the review popup and GitHub prefill

**Files:**
- Modify: `src/diagnostics/reportIssueModel.ts` (`coreLines` + `buildReviewSummary` + `DISCLOSURE`)
- Modify: `src/diagnostics/issuePrefill.ts` (`coreLines` line in the body)
- Test: `src/diagnostics/reportIssueModel.test.ts`
- Test: `src/diagnostics/issuePrefill.test.ts`

**Interfaces:**
- Consumes: `FinalizedDiagnosticReport` (existing); the `cores` section produced by Task 2 (`data` is an array of `{ core, headlessCalls, headlessTokens, interactiveCalls, interactiveTokens, sessions, models, firstSeenAt, lastSeenAt }` — all fields strings/numbers/null)
- Produces:
  - `coreLines(snapshot: FinalizedDiagnosticReport): string[]` — one line per report, `- Cores used: opencode (12 headless · 2 interactive · 2 sessions · 1.3M tokens), codex (3 headless · 1 session · 8.4k tokens)`; `[]` when the section is absent/unavailable.
  - `buildReviewSummary` (existing) includes `...coreLines(snapshot)` after the hook lines.
  - `buildIssuePrefill` body gains a `### Agent cores` section (present only when `coreLines` is non-empty).

- [ ] **Step 1: Write the failing tests**

In `src/diagnostics/reportIssueModel.test.ts`, append:

```ts
function withCores(): FinalizedDiagnosticReport {
  const base = snapshot()
  return {
    ...base,
    report: {
      ...base.report,
      metadata: {
        ...base.report.metadata,
        cores: {
          status: 'available',
          data: [
            {
              core: 'opencode',
              headlessCalls: 12,
              headlessTokens: { input: 900000, output: 400000, total: 1300000 },
              interactiveCalls: 2,
              interactiveTokens: { input: 10, output: 5, total: 15 },
              sessions: 2,
              models: ['opencode-go/deepseek-v4-flash'],
              firstSeenAt: '2026-08-01T00:00:00.000Z',
              lastSeenAt: '2026-08-02T00:00:00.000Z',
            },
            {
              core: 'codex',
              headlessCalls: 3,
              headlessTokens: { input: 4000, output: 4400, total: 8400 },
              interactiveCalls: 0,
              interactiveTokens: { input: 0, output: 0, total: 0 },
              sessions: 1,
              models: ['gpt-5-codex'],
              firstSeenAt: null,
              lastSeenAt: null,
            },
          ],
        },
      },
    },
  }
}

it('names every used agent core in the review summary', () => {
  const summary = buildReviewSummary(withCores())
  expect(summary).toContain('Cores used:')
  expect(summary).toContain('opencode (12 headless · 2 interactive · 2 sessions · 1.3M tokens)')
  expect(summary).toContain('codex (3 headless · 1 session · 8.4k tokens)')
})

it('omits the cores line when the section is unavailable', () => {
  const base = snapshot()
  const summary = buildReviewSummary({
    ...base,
    report: {
      ...base.report,
      metadata: { ...base.report.metadata, cores: { status: 'unavailable', reason: 'reader_failed' } },
    },
  })
  expect(summary).not.toContain('Cores used:')
})
```

In `src/diagnostics/issuePrefill.test.ts`, append:

```ts
it('prefills every used agent core into the handoff form', () => {
  const withCores = snapshotWithCores()
  const prefill = buildIssuePrefill(withCores, '1.2.3')
  expect(prefill.body).toContain('### Agent cores')
  expect(prefill.body).toContain('opencode (12 headless · 2 interactive · 2 sessions · 1.3M tokens)')
})
```

(`snapshotWithCores` mirrors the `withCores` helper above, but adapted to that file's existing `snapshot()` factory — check the existing helper at the top of `issuePrefill.test.ts` and reuse its shape. If the file has no `snapshot()` factory, build a `FinalizedDiagnosticReport` from the existing fixture used by its first test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diagnostics/reportIssueModel.test.ts src/diagnostics/issuePrefill.test.ts`
Expected: FAIL — `Cores used:` / `### Agent cores` absent.

- [ ] **Step 3: Implement `coreLines` and wire it in**

In `src/diagnostics/reportIssueModel.ts`:

```ts
function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * One line naming every agent core the ticket actually used, from the
 * append-only `cores` section — a mid-session core switch leaves both cores
 * visible. Absent/unavailable section reads as no line, like the hook lines.
 */
export function coreLines(snapshot: FinalizedDiagnosticReport): string[] {
  const section = snapshot.report.metadata.cores
  if (!section || section.status === 'unavailable') return []
  const rows = Array.isArray(section.data) ? section.data : []
  const parts: string[] = []
  for (const row of rows) {
    const value = row as Record<string, unknown>
    const core = typeof value.core === 'string' ? value.core : null
    if (core === null) continue
    const headless = typeof value.headlessCalls === 'number' ? value.headlessCalls : 0
    const interactive = typeof value.interactiveCalls === 'number' ? value.interactiveCalls : 0
    const sessions = typeof value.sessions === 'number' ? value.sessions : 0
    const tokens =
      value.headlessTokens && typeof value.headlessTokens === 'object'
        ? (value.headlessTokens as Record<string, unknown>).total
        : null
    const tokenTotal = typeof tokens === 'number' ? formatTokens(tokens) : null
    const bits = [
      ...(headless > 0 ? [`${headless} headless`] : []),
      ...(interactive > 0 ? [`${interactive} interactive`] : []),
      ...(sessions > 0 ? [`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`] : []),
      ...(tokenTotal !== null && tokenTotal !== '0' ? [`${tokenTotal} tokens`] : []),
    ]
    if (bits.length > 0) parts.push(`${core} (${bits.join(' · ')})`)
  }
  return parts.length > 0 ? [`- Cores used: ${parts.join(', ')}`] : []
}
```

In `buildReviewSummary`, after the `hooks` spread, add:

```ts
...coreLines(snapshot),
```

Update `DISCLOSURE.included` so the disclosure names the new evidence:

```ts
included:
  'Included now — diagnostic metadata: runtime, report-local correlation references, '
  + 'stages, gates, phases, effective configuration, hook-channel counters, per-core '
  + 'agent usage evidence, registry schema version and row counts, and bounded '
  + 'sanitized Karst logs.',
```

- [ ] **Step 4: Add the prefill section**

In `src/diagnostics/issuePrefill.ts`, import `coreLines` from `./reportIssueModel.js` (it is a host-agnostic module; the prefill file already lives beside it — verify no cycle: `reportIssueModel.ts` imports `issuePrefill.ts`, so importing `reportIssueModel` back into `issuePrefill` is a CYCLE. Instead, export `coreLines` from `issuePrefill.ts` itself — it only needs `FinalizedDiagnosticReport`, which both files import. Move the `coreLines` implementation from `reportIssueModel.ts` into `issuePrefill.ts` and have `reportIssueModel.ts` import it from there, exactly like the existing `hookLines` pattern.)

Concretely:
- Implement `coreLines` + `formatTokens` in `src/diagnostics/issuePrefill.ts` (next to `hookLines`), exported.
- In `src/diagnostics/reportIssueModel.ts`, change the import on line 2 to `import { buildIssuePrefill, coreLines, hookLines } from './issuePrefill.js'` and delete the local copies added in Step 3.
- In `buildIssuePrefill`, after the `hooks.length` block, add:

```ts
const cores = coreLines(snapshot)
```

and in the body array, after the `'### Hook channel'` block, add:

```ts
...(cores.length > 0 ? ['### Agent cores', '', ...cores, ''] : []),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/diagnostics/reportIssueModel.test.ts src/diagnostics/issuePrefill.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full diagnostics suite**

Run: `npx vitest run src/diagnostics`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/diagnostics/reportIssueModel.ts src/diagnostics/issuePrefill.ts src/diagnostics/reportIssueModel.test.ts src/diagnostics/issuePrefill.test.ts
git commit -m "feat(diagnostics): surface every used agent core in the review popup and GitHub prefill"
```

---

### Task 4: Document the invariant and verify the whole build

**Files:**
- Modify: `AGENTS.md` (the issue-reporting bullet)
- No code changes

**Interfaces:** none — documentation + verification only.

- [ ] **Step 1: Update AGENTS.md**

In the bullet starting `- **The GitHub handoff form is prefilled from the FINALIZED snapshot...**` (or the neighbouring `Issue reporting OBSERVES` bullet), append a sentence describing the new invariant:

```markdown
The report's `cores` section is the whole history of agent cores used on a ticket — headless
calls (`token_usage`), interactive usage (`interactive_usage_samples`), and confirmed sessions
(`session_launch_intents`) merged per provider — read from append-only evidence, so a core
switched mid-session still reports its rows; it never relies on the last-writer-wins
`tickets.session_provider`, which is only the live session's tag. `NULL`-provider rows are
bucketed as `unknown`, never dropped.
```

- [ ] **Step 2: Run the entire test suite**

Run: `npm test`
Expected: PASS (the `pretest` hook rebuilds better-sqlite3 for the Node ABI first).

- [ ] **Step 3: Run the typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs: report all used agent cores, not just the latest session or codex bridge"
```

---

## Self-Review

**1. Spec coverage:** "Report is including only codex" — the report's only core-specific evidence was `hooks.bridge` (codex) and `session.provider` (latest session); Task 2 adds the `cores` section covering every core, Task 3 surfaces it in the preview popup (the exact surface the ticket names) and the GitHub prefill. "should include all data from used agent cores" — headless calls, interactive usage, sessions and models per core (Task 1). "make sure will be included after switching mid-session" — every source is append-only per ticket; the Task 2 test seeds a codex→claude switch and asserts both cores appear.

**2. Placeholder scan:** No TBD/TODO; every step carries concrete code or commands. The one "adapt to the file's existing factory" instruction in Task 3 Step 1 names exactly what to mirror and what to check.

**3. Type consistency:** `readCoreUsage` signature and `CoreUsageEvidence` fields are identical across Task 1 (definition), Task 2 (consumer), Task 3 (renderer). `collectProjectCores` is defined in Task 2 Step 4 and replaces its own placeholder in the same step (the placeholder line is flagged as replaced below). `coreLines` is defined in `issuePrefill.ts` and imported by `reportIssueModel.ts` per the existing `hookLines` pattern — the step ordering makes the final location unambiguous (implement once in `issuePrefill.ts`, import from there).
