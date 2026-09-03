# Execution Plan: Fix interactive token `total` excluding cache-read tokens

## Goal

`readCoreUsage` in `src/diagnostics/storeEvidence.ts` reports two fields named `total` (headless and interactive) that currently have different semantics: headless `total` always includes cache-read tokens, but interactive `total` silently drops cache-read tokens whenever the provider never reported its own `total_tokens` value. After this change, interactive `total`'s fallback path also includes cache-read tokens, so both fields consistently mean "input + output + cache_read" whenever the fallback is used.

## Current State

`src/diagnostics/storeEvidence.ts`, function `readCoreUsage` (starts line 573):

- Headless query (lines 583-595) reads from `token_usage`. `total_tokens` there is `NOT NULL DEFAULT 0` (schema.sql:711) and is always populated by the writer, so `SUM(total_tokens)` (line 588) is always a real, non-fallback value that already includes cache reads (established behavior, not touched by this plan).
- Interactive query (lines 597-613) reads from `interactive_usage_samples`. `total_tokens` there is nullable (schema.sql:790 — "NULL = the provider reported no such counter"). The query's `total` column (lines 602-603) is currently:
  ```sql
  COALESCE(SUM(s.total_tokens),
           COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0)) AS total,
  ```
  SQLite's `SUM` ignores NULL rows and only returns NULL if every row in the GROUP BY group has NULL `total_tokens`. In that all-NULL case, the fallback (`SUM(input_tokens) + SUM(output_tokens)`) is used, and it omits `cache_read_tokens` — even though the same row/group has a `cache_read_tokens` value that IS summed separately into the `cache_read` column (line 604) and IS included in `held.interactiveTokens.cacheRead` via `absorb()` (line 664).
- `absorb()` (lines 655-669) sums `row.total` directly into `tokens.total` (line 663) with no adjustment — it trusts whatever the SQL produced.
- Observed effect (2026-09-03 diagnostic report on ticket DIAGNOSTIC-REPORT-CHECK): interactive `total` for the `claude` core was `3,241,660`, exactly `input (35,126) + output (3,206,534)`, while `cacheRead` was `513,774,677` and was excluded from `total` — because every interactive sample row for that group had `total_tokens = NULL`.
- Existing test `src/diagnostics/storeEvidence.test.ts`, function `seedUsageEvidence` (lines 191-223) inserts `interactive_usage_samples` rows with `total_tokens` explicitly set (700 and 400, line 213), so the fallback path is never exercised by current tests. `cache_read_tokens` and `cache_write_tokens` are omitted from that INSERT's column list entirely, so they default per schema — check schema for the column defaults before writing new test SQL (see Task 1, step 1).

## Target State

When an interactive core's `total_tokens` is NULL for every row in its GROUP BY group (the fallback path), `readCoreUsage`'s interactive `total` equals `SUM(input_tokens) + SUM(output_tokens) + SUM(cache_read_tokens)`, so it is consistent with the headless `total` semantics (always inclusive of cache reads). The non-fallback path (real `SUM(s.total_tokens)` present) is untouched — this plan does not change what happens when the provider *does* report its own total.

## Scope

### In Scope
- The interactive query's fallback expression in `readCoreUsage` (`src/diagnostics/storeEvidence.ts`, lines 602-603).
- A new unit test in `src/diagnostics/storeEvidence.test.ts` covering the fallback-with-cache-read path.

### Out of Scope
- The headless query (lines 583-595) — not touched.
- The `absorb()` function, `CoreUsageTokens` type, `zeroTokens()` — not touched; no signature or shape changes.
- `schema.sql`, migrations, any other diagnostic report section.
- The diagnostic report's rendering/labeling layer (`collectMetadata.ts`) — this plan fixes the underlying data, not the report's field labels or documentation.
- Any behavior when `s.total_tokens` IS reported (non-fallback path) — unchanged.

## Key Decisions

1. Fix at the SQL fallback expression, not by post-processing in `absorb()` or by adding a new field — keeps the change to one line and preserves the existing `CoreUsageTokens { input, output, total, cacheRead }` shape used throughout the diagnostics module (verified via `grep -rln "headlessTokens" src`: `issuePrefill.ts`, `collectMetadata.ts`, and their tests all consume this shape as-is).
2. The fallback becomes `COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0) + COALESCE(SUM(s.cache_read_tokens), 0)` — added as a third term, reusing the existing `COALESCE(SUM(...), 0)` pattern already used for input/output in the same expression for consistency.

## Execution Order

### Task 1: Add failing test for the fallback-with-cache-read path

#### Objective
Add a test to `src/diagnostics/storeEvidence.test.ts` that inserts an `interactive_usage_samples` row with `total_tokens = NULL` and `cache_read_tokens > 0`, and asserts that `readCoreUsage`'s `interactiveTokens.total` for that core equals `input + output + cache_read` (not just `input + output`). Run it and confirm it fails against the current implementation.

#### Files
- `src/diagnostics/storeEvidence.test.ts` — add one new `it(...)` test case in the same `describe` block that contains the existing `seedUsageEvidence`-based tests (the block spanning lines ~191-281; add the new test immediately after the `'scopes readCoreUsage to the ticket or project and caps rows'` test, i.e. after line 281's closing, before whatever follows).

#### Implementation
1. Before writing the INSERT, check `interactive_usage_samples`' column defaults for `cache_read_tokens` and `cache_write_tokens` in `src/store/schema.sql` (around line 776-791) to confirm whether they are nullable with no default (if so, they must be supplied explicitly in the new INSERT, unlike `seedUsageEvidence`'s INSERT which omits them and would otherwise insert NULL — NULL cache_read_tokens summed via SQL `SUM` would contribute 0, which is fine for the *other* existing tests since they don't assert on cacheRead, but the new test must supply a non-NULL, non-zero value explicitly).
2. Add a new test function-local setup (do not modify `seedUsageEvidence` — it is shared by two existing passing tests and changing its shared INSERT would risk altering their asserted values):
   ```typescript
   it('includes cache-read tokens in interactive total when the provider never reports its own total_tokens', () => {
     store = openStore(':memory:')
     const project = upsertProject(store, { slug: 'p3' })
     const ticket = createTicket(store, { projectId: project.id, key: 'K-3', title: 't3' })

     store.db.prepare(
       `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
        VALUES (?, 'impl', 'session', 1, 'passed', '2026-07-28T08:00:00.000Z')`,
     ).run(ticket.id)
     const processId = (
       store.db.prepare('SELECT id FROM process_runs WHERE ticket_id = ?').get(ticket.id) as { id: number }
     ).id

     store.db.prepare(
       `INSERT INTO interactive_usage_samples
         (process_run_id, source_event_id, provider, provider_session_id,
          input_tokens, output_tokens, total_tokens, cache_read_tokens, baseline_only, observed_at)
        VALUES (?, 'ev-cache-1', 'claude', 'sess-claude-1', 1000, 500, NULL, 200000, 0, '2026-07-28T11:00:00.000Z'),
               (?, 'ev-cache-2', 'claude', 'sess-claude-1', 300, 100, NULL, 50000, 0, '2026-07-28T12:00:00.000Z')`,
     ).run(processId, processId)

     const result = readCoreUsage(store, { ticketId: ticket.id }, 10)
     const claude = result.rows.find((row) => row.core === 'claude')

     expect(claude).toMatchObject({
       interactiveCalls: 2,
       interactiveTokens: {
         input: 1300,
         output: 600,
         cacheRead: 250000,
         total: 251900, // 1300 + 600 + 250000 — fallback must include cache_read
       },
     })
   })
   ```
3. This test uses only `openStore`, `upsertProject`, `createTicket`, `readCoreUsage` — all already imported at the top of the test file (confirmed by the existing tests in the same block using them identically). No new imports are required.

#### Constraints
- Do not modify `seedUsageEvidence` or any existing test case.
- Do not add `total_tokens` to the new INSERT rows (must stay NULL to exercise the fallback path).
- Use a `project` slug and `ticket` key not already used elsewhere in the file (`p3` / `K-3`) to avoid collisions if tests share a database instance improperly — confirm the file's `beforeEach`/`afterEach` pattern (check top of file) creates a fresh `store` per test via `openStore(':memory:')` as done in the two existing tests, so this is likely already isolated, but keep unique identifiers regardless as defensive practice matching existing test style (existing tests use `'p'`/`'K-1'`, `'q'`/`'K-2'`).

#### Edge Cases
- None beyond the fallback path itself — this task's sole purpose is to prove the fallback drops cache_read today.

#### Verification
```bash
npx vitest run src/diagnostics/storeEvidence.test.ts
```
Expected: the new test FAILS with `total: 251900` expected but `1900` (1300+600) received; all other existing tests in the file continue to PASS.

#### Completion Criteria
- [ ] New test added to `src/diagnostics/storeEvidence.test.ts`.
- [ ] `npx vitest run src/diagnostics/storeEvidence.test.ts` run and confirmed: new test fails, all pre-existing tests in the file still pass.

### Task 2: Fix the interactive query fallback to include cache_read_tokens

#### Objective
Change the SQL fallback expression in `readCoreUsage`'s interactive query so that when `total_tokens` is NULL for every row in a group, the computed `total` includes `cache_read_tokens`.

#### Files
- `src/diagnostics/storeEvidence.ts` — modify lines 602-603 only.

#### Implementation
Current (lines 597-613):
```sql
  const interactiveRows = store.db.prepare(
    `SELECT s.provider AS core,
            COUNT(*) AS calls,
            COALESCE(SUM(s.input_tokens), 0) AS input,
            COALESCE(SUM(s.output_tokens), 0) AS output,
            COALESCE(SUM(s.total_tokens),
                     COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0)) AS total,
            COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read,
            MIN(s.observed_at) AS first_at,
            MAX(s.observed_at) AS last_at
       FROM interactive_usage_samples s
       JOIN process_runs p ON p.id = s.process_run_id
       ${ticket
         ? 'WHERE p.ticket_id = ?'
         : 'JOIN tickets t ON t.id = p.ticket_id WHERE t.project_id = ?'}
      GROUP BY s.provider`,
  ).all(...params) as CoreTotalsRow[]
```
Change the `total` expression (lines 602-603) to:
```sql
            COALESCE(SUM(s.total_tokens),
                     COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0)
                       + COALESCE(SUM(s.cache_read_tokens), 0)) AS total,
```
No other line in the query changes. The `cache_read` column (current line 604, unchanged) stays as its own separate `SUM(s.cache_read_tokens)` — this is still needed since `held.interactiveTokens.cacheRead` (populated via `absorb()`, line 664) is a distinct field from `total` and must remain populated exactly as before.

#### Constraints
- Do not change the headless query (lines 583-595).
- Do not change `absorb()` (lines 655-669) — no logic change needed there; it already sums whatever `row.total` the SQL produces.
- Do not change the non-fallback path's behavior: when `SUM(s.total_tokens)` is non-NULL (i.e., at least one row in the group has a reported `total_tokens`), that value is used as-is, exactly as today.
- Do not change `CoreTotalsRow`, `CoreUsageTokens`, `HeldCoreUsage`, or any exported type.

#### Edge Cases
- Mixed group where some rows have `total_tokens` set and others NULL: SQLite `SUM` ignores NULLs, so `SUM(s.total_tokens)` returns the sum of only the non-NULL rows (not NULL overall), so the fallback is NOT triggered and rows with NULL `total_tokens` in that mixed group contribute 0 to `total` (pre-existing behavior, unchanged by this plan — out of scope to fix, since fixing it would require summing per-row COALESCE rather than group-level COALESCE, which is a different, unrequested change).
- Group where `cache_read_tokens` is NULL for a given row: `SUM` ignores NULL rows, contributing 0 for that row — matches existing behavior of the separate `cache_read` column (line 604), no new behavior introduced.

#### Verification
```bash
npx vitest run src/diagnostics/storeEvidence.test.ts
```
Expected: ALL tests in the file pass, including the new test from Task 1 (`interactiveTokens.total` now equals `251900`).

#### Completion Criteria
- [ ] Lines 602-603 in `src/diagnostics/storeEvidence.ts` updated exactly as specified.
- [ ] `npx vitest run src/diagnostics/storeEvidence.test.ts` passes with zero failures.

## Final Verification

1. Run the full diagnostics test suite to confirm no other diagnostics test depended on the old (buggy) fallback behavior.
2. Run typecheck to confirm no type regressions (no types were changed, but confirm compilation is clean).

Commands:
```bash
npx vitest run src/diagnostics/storeEvidence.test.ts
npx vitest run src/diagnostics/collectMetadata.test.ts
npx vitest run src/diagnostics/issuePrefill.test.ts
npx vitest run src/diagnostics/reportIssueModel.test.ts
npm run typecheck
```

Expected:
- All four test files pass with zero failures.
- `typecheck` completes with no errors.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:
- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:
- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must not propose or implement an alternative unless explicitly asked to re-plan.
