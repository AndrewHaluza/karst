# Abandoned Graph Run Strands A Ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs that cause abandoned graph runs to strand tickets: (1) `deleteTicket` omits `approach_graph_workspaces` causing FK violations on delete, (2) impl marker routes on any graph run row ignoring ticket approach and run status, stranding direct-approach tickets, (3) refusal message doesn't explain the ticket is on direct approach or that the run is terminal.

**Architecture:** The fix spans three modules: `src/store/tickets.ts` (deleteTicket), `src/cli/stage.ts` (impl marker routing), and `src/workflow/graphMarkerGuard.ts` (refusal message). All changes are host-agnostic and covered by existing vitest unit tests with in-memory SQLite.

**Tech Stack:** TypeScript, ESM, vitest, better-sqlite3 (in-memory for tests), SQLite schema with explicit FK constraints (no ON DELETE CASCADE).

## Global Constraints

- Foreign keys are ON; deletion order is the product contract, never SQLite discovery
- `vscode` is never a runtime import — logic takes injected interfaces, runs under vitest with fakes
- Strict TDD (RED→GREEN): behavior lands with its test in the same commit
- Files stay small (200–400 lines typical); colocated tests as `<module>.test.ts`
- Conventional commits: `fix(store): …`, `fix(cli): …`, `fix(workflow): …`
- Debug logging via injected callbacks (`[driver]`, `[gate]`, `[agent:*]`, `[runtime]`, `[merge]`, `[process]`)

---

### Task 1: Add `approach_graph_workspaces` to deleteTicket deletion sequence

**Files:**
- Modify: `src/store/tickets.ts:672-693`
- Test: `src/store/tickets.test.ts:860-1022` (existing `deleteTicket — graph evidence` describe block)

**Interfaces:**
- Consumes: existing `deleteTicket(store, ticketId, graphBytesRoot?, artifactsRoot?)` signature
- Produces: same signature; deletion now includes `approach_graph_workspaces` before `approach_node_runs`

- [ ] **Step 1: Write the failing test** — Add a test that creates a ticket with a graph run that has a materialized workspace, then calls `deleteTicket` and verifies it succeeds without FK error

```typescript
// In src/store/tickets.test.ts, inside the 'deleteTicket — graph evidence' describe block
it('deletes a ticket whose graph run has a materialized workspace without FK violation', () => {
  const { ticketId } = seedGraphTicket();
  // The seed already creates a workspace row (line 940-944)
  // Verify workspace exists
  const wsCount = store.db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_workspaces')
    .get() as { n: number };
  expect(wsCount.n).toBe(1);
  // This should NOT throw FOREIGN KEY constraint failed
  expect(() => deleteTicket(store, ticketId)).not.toThrow();
  // Verify all graph tables are empty
  for (const table of [
    'approach_graph_tokens',
    'approach_node_overrides',
    'approach_resource_leases',
    'approach_node_deferrals',
    'approach_artifact_instances',
    'approach_graph_workspaces',
    'approach_node_runs',
    'approach_planner_runs',
    'approach_graph_revisions',
    'approach_graph_runs',
  ]) {
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    expect(n.n, table).toBe(0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/tickets.test.ts -t "deletes a ticket whose graph run has a materialized workspace"`
Expected: FAIL with "FOREIGN KEY constraint failed" on `approach_node_runs` delete

- [ ] **Step 3: Write minimal implementation** — Add `DELETE FROM approach_graph_workspaces WHERE graph_run_id = ?` before `approach_node_runs` in the per-graph-run loop

```typescript
// In src/store/tickets.ts, inside the for (const graphRunId of graphRunIds) loop (around line 688)
// Add this line BEFORE the approach_node_runs delete (line 689):
store.db.prepare('DELETE FROM approach_graph_workspaces WHERE graph_run_id = ?').run(graphRunId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/tickets.test.ts -t "deletes a ticket whose graph run has a materialized workspace"`
Expected: PASS

- [ ] **Step 5: Run full test suite for tickets to ensure no regression**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/tickets.ts src/store/tickets.test.ts
git commit -m "fix(store): deleteTicket includes approach_graph_workspaces before approach_node_runs to avoid FK violation"
```

---

### Task 2: Gate impl marker routing on ticket approach and non-terminal run status

**Files:**
- Modify: `src/cli/stage.ts:207-245`
- Test: `src/cli/stage.test.ts` (new test file — create if missing)

**Interfaces:**
- Consumes: `runStageCommand(store, ticketId, argv, transition, ticket?)` — existing signature
- Produces: same signature; routing now checks `ticket.approach === BUILT_IN_PACKAGE_ID` AND run status not in `['cancelled', 'closed', 'stale']`

- [ ] **Step 1: Write the failing test** — Create `src/cli/stage.test.ts` with tests for the three routing scenarios

```typescript
// src/cli/stage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { runStageCommand } from './stage.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';
import { stageAttempt } from '../store/stages.js';

describe('runStageCommand — impl marker routing', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seedDirectTicketWithCancelledGraphRun(): number {
    const ticketId = createTicket(store, { key: 'DIR-1', title: 'direct' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = ? WHERE id = ?").run('direct', ticketId);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned: gateway node claimed dbgw paths', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);
    return ticketId;
  }

  function seedGraphTicketWithCancelledRun(): number {
    const ticketId = createTicket(store, { key: 'GRAPH-1', title: 'graph' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = ? WHERE id = ?").run(BUILT_IN_PACKAGE_ID, ticketId);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);
    return ticketId;
  }

  function seedGraphTicketWithRunningRun(): number {
    const ticketId = createTicket(store, { key: 'GRAPH-2', title: 'graph running' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = ? WHERE id = ?").run(BUILT_IN_PACKAGE_ID, ticketId);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', ?, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);
    return ticketId;
  }

  it('allows direct-approach ticket with cancelled graph run to pass impl via markImplementDone', () => {
    const ticketId = seedDirectTicketWithCancelledGraphRun();
    // Should NOT throw "graph marker refused" — should fall through to markImplementDone
    const result = runStageCommand(store, ticketId, ['stage', 'impl', 'pass']);
    expect(result).toBe('uat');
  });

  it('refuses graph-approach ticket with cancelled run (terminal, will never be marker-ready)', () => {
    const ticketId = seedGraphTicketWithCancelledRun();
    expect(() => runStageCommand(store, ticketId, ['stage', 'impl', 'pass'])).toThrow(
      /graph marker refused: graph run \d+ is cancelled — a terminal state, so it will never become marker-ready/,
    );
  });

  it('refuses graph-approach ticket with running run (not marker-ready)', () => {
    const ticketId = seedGraphTicketWithRunningRun();
    expect(() => runStageCommand(store, ticketId, ['stage', 'impl', 'pass'])).toThrow(
      /graph marker refused: graph run \d+ is running, not marker-ready/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/stage.test.ts`
Expected: FAIL — direct-approach ticket throws "graph marker refused: graph run 1 is cancelled, not marker-ready"

- [ ] **Step 3: Write minimal implementation** — Update the routing logic in `runStageCommand` to check ticket approach AND filter out terminal run statuses

```typescript
// In src/cli/stage.ts, replace lines 217-235 with:
if (stage === 'impl') {
  // The graph marker guard is the ONLY graph/stage boundary. Its routing
  // must apply only to graph-approach tickets: a `direct` ticket with a
  // leftover graph-run row (a mid-flight approach switch, a partial
  // bootstrap) is not a graph ticket, and routing it to the guard would
  // strand it at impl with no exit. The guard's own no-run sibling
  // (`graphApproachMissingRun`) gates on the same approach id for the same
  // reason. The store is the real db-backed store in production; the test
  // seam may stub it without `db` — the graph check simply does not apply
  // then.
  const isGraphApproach = store.db
    ? getTicket(store, ticketId).approach === BUILT_IN_PACKAGE_ID
    : false;
  const hasGraphRun =
    isGraphApproach &&
    (store.db
      ? (
          store.db
            .prepare(
              `SELECT 1 AS n FROM approach_graph_runs
               WHERE ticket_id = ? AND status NOT IN ('cancelled', 'closed', 'stale')
               LIMIT 1`,
            )
            .get(ticketId) as { n: number } | undefined
        ) !== undefined
      : false);
  if (hasGraphRun) {
    const result = graphImplMarkerGuard(store, ticketId);
    if (!result.ok) {
      throw new Error(`graph marker refused: ${result.reason}`);
    }
    return 'uat';
  }
  // A graph-approach ticket with NO graph run at all (bootstrap failed, the
  // run was cancelled before it was created, a misconfiguration) must never
  // fall through to the plain marker below — that would advance the ticket
  // with zero graph work performed. Refuse the marker, name why, and leave
  // the ticket exactly where it is.
  if (store.db && graphApproachMissingRun(store, ticketId)) {
    throw new Error(
      `graph marker refused: no graph run for ticket ${ticketId} (approach ${BUILT_IN_PACKAGE_ID})`,
    );
  }
  // The impl marker routes through markImplementDone, never directly through
  // the generic transition: completing the stable implementation run (closing
  // its segment and Session process run, passing the run) is part of the
  // marker's job, folded into the SAME transaction as the stage advance.
  return markImplementDone(store, ticketId, transition);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/stage.test.ts`
Expected: All three tests PASS

- [ ] **Step 5: Run existing graphMarkerGuard tests to ensure no regression**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/stage.ts src/cli/stage.test.ts
git commit -m "fix(cli): impl marker routing gates on ticket approach and ignores terminal graph run statuses"
```

---

### Task 3: Improve refusal message for terminal graph runs to explain direct approach and terminal state

**Files:**
- Modify: `src/workflow/graphMarkerGuard.ts:64-82` (`graphRunNotMarkerReadyMessage` function)
- Test: `src/workflow/graphMarkerGuard.test.ts:170-180` (existing test "says a cancelled run is terminal and will never become marker-ready")

**Interfaces:**
- Consumes: `GraphRunRow { id: number; status: string; blocked_reason: string | null }`
- Produces: `string` — enhanced message that includes ticket approach context when available

- [ ] **Step 1: Write the failing test** — Update the existing test to expect the enhanced message that mentions the ticket's approach

```typescript
// In src/workflow/graphMarkerGuard.test.ts, update the existing test at line 170-180
it('says a cancelled run is terminal and will never become marker-ready', () => {
  const { ticketId } = markerReadyTicket('GM-TERM');
  store.db
    .prepare("UPDATE approach_graph_runs SET status = 'cancelled' WHERE ticket_id = ?")
    .run(ticketId);
  const result = graphImplMarkerGuard(store, ticketId);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain('cancelled');
  expect(result.reason).toContain('terminal');
  expect(result.reason).toContain('never become marker-ready');
  // NEW: message should mention the ticket's approach if it's not the graph approach
  // (this will fail until we update the message function to accept ticket context)
});
```

- [ ] **Step 2: Run test to verify it fails** (the test will fail because the message doesn't yet include approach context)

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts -t "says a cancelled run is terminal"`
Expected: FAIL — message doesn't mention approach context (but this is expected; the test assertion for approach context will be added after implementation)

Actually, let me refine: the `graphRunNotMarkerReadyMessage` function doesn't have access to the ticket. We need to either:
- Pass the ticket approach to the function, OR
- Have the caller (`graphImplMarkerGuard`) construct the enhanced message

Let me update the approach:

- [ ] **Step 1 revised: Write the failing test** — Add a NEW test that verifies the refusal message for a direct-approach ticket includes approach context

```typescript
// In src/workflow/graphMarkerGuard.test.ts, add a new test in the 'graphImplMarkerGuard' describe block
it('refusal message for direct-approach ticket with cancelled run names the approach and terminal state', () => {
  const ticketId = createTicket(store, { key: 'DIR-MSG', title: 'direct' }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = 'direct' WHERE id = ?").run(ticketId);
  store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
  const attempt = stageAttempt(store, ticketId, 'impl');
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt)
      .lastInsertRowid,
  );
  // Need a revision for the run to exist (graphRunFor needs it)
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
    )
    .run(graphRunId);

  const result = graphImplMarkerGuard(store, ticketId);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain('direct'); // approach name
  expect(result.reason).toContain('terminal');
  expect(result.reason).toContain('never become marker-ready');
});
```

- [ ] **Step 2 revised: Run test to verify it fails**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts -t "refusal message for direct-approach ticket"`
Expected: FAIL — message doesn't contain 'direct'

- [ ] **Step 3: Write minimal implementation** — Update `graphImplMarkerGuard` to include ticket approach in the refusal message when the run is terminal

```typescript
// In src/workflow/graphMarkerGuard.ts, modify graphImplMarkerGuard function (around line 136-137)
// Replace the throw with enhanced message:
if (run.status !== 'completed-awaiting-impl-marker') {
  const ticket = getTicket(store, ticketId);
  const approachContext = ticket.approach && ticket.approach !== BUILT_IN_PACKAGE_ID
    ? ` (ticket approach: ${ticket.approach})`
    : '';
  throw new Error(`${graphRunNotMarkerReadyMessage(run)}${approachContext}`);
}
```

Also update `graphRunNotMarkerReadyMessage` to be more explicit about terminal states:

```typescript
// In src/workflow/graphMarkerGuard.ts, replace lines 73-82:
/**
 * Name why a non-marker-ready run refuses the impl marker. A terminal run is
 * the dead end: it will never become marker-ready, so the message says so and
 * names the only way past impl instead of leaving the reader hunting for a
 * fix that does not exist. A blocked run carries its durable blocker.
 */
function graphRunNotMarkerReadyMessage(run: GraphRunRow): string {
  if (TERMINAL_GRAPH_RUN_STATUSES.has(run.status)) {
    return (
      `graph run ${run.id} is ${run.status} — a terminal state, so it will never become ` +
      `marker-ready; the only way past impl is a new graph run for this ticket`
    );
  }
  const blocked = run.blocked_reason !== null ? ` — ${run.blocked_reason}` : '';
  return `graph run ${run.id} is ${run.status}, not marker-ready${blocked}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts -t "refusal message for direct-approach ticket"`
Expected: PASS

- [ ] **Step 5: Run all graphMarkerGuard tests to ensure no regression**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/workflow/graphMarkerGuard.ts src/workflow/graphMarkerGuard.test.ts
git commit -m "fix(workflow): graph marker refusal message includes ticket approach for direct tickets and clarifies terminal state"
```

---

### Task 4: Verify end-to-end with integration test

**Files:**
- Test: `src/workflow/lifecycle.integration.test.ts` (or create new integration test)

**Interfaces:**
- Consumes: Full workflow from ticket creation through graph run cancellation to impl marker
- Produces: Verification that a direct-approach ticket with abandoned graph run can pass impl

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/workflow/lifecycle.integration.test.ts (or new file)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { runStageCommand } from '../cli/stage.js';
import { BUILT_IN_PACKAGE_ID } from '../approaches/builtInId.js';
import { stageAttempt } from '../store/stages.js';

describe('Abandoned graph run — direct ticket can pass impl', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('a direct-approach ticket with a cancelled graph run can pass impl', () => {
    const ticketId = createTicket(store, { key: 'E2E-1', title: 'e2e' }).id;
    // Set up as direct approach with a cancelled graph run (simulating abandoned attempt)
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = 'direct' WHERE id = ?").run(ticketId);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned: gateway node claimed dbgw paths against the web-contract domain', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);

    // Advance through scope -> impl (already at impl)
    // Fire impl marker — should succeed via markImplementDone, not graph guard
    const nextStage = runStageCommand(store, ticketId, ['stage', 'impl', 'pass']);
    expect(nextStage).toBe('uat');

    // Verify ticket advanced
    const ticket = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as { stage_current: string };
    expect(ticket.stage_current).toBe('uat');
  });

  it('a graph-approach ticket with cancelled run is refused with clear message', () => {
    const ticketId = createTicket(store, { key: 'E2E-2', title: 'e2e graph' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl', approach = ? WHERE id = ?").run(BUILT_IN_PACKAGE_ID, ticketId);
    store.db.prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'").run(ticketId);
    const attempt = stageAttempt(store, ticketId, 'impl');
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, created_at)
         VALUES (?, 'impl', ?, 'x', 'cancelled', 'abandoned', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, attempt);
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(
        store.db.prepare('SELECT id FROM approach_graph_runs WHERE ticket_id = ?').get(ticketId) as { id: number },
      );

    expect(() => runStageCommand(store, ticketId, ['stage', 'impl', 'pass'])).toThrow(
      /graph marker refused: graph run \d+ is cancelled — a terminal state, so it will never become marker-ready/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/lifecycle.integration.test.ts -t "Abandoned graph run"`
Expected: FAIL (first test fails because direct ticket still routes to graph guard)

- [ ] **Step 3: Implementation already done in Tasks 2-3**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/lifecycle.integration.test.ts -t "Abandoned graph run"`
Expected: PASS

- [ ] **Step 5: Run full test suite to ensure no regression**

Run: `npm run test:unit`
Expected: All tests PASS

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/workflow/lifecycle.integration.test.ts
git commit -m "test(integration): abandoned graph run does not strand direct-approach ticket at impl"
```

---

### Task 5: Verify deleteTicket works with graph workspaces on disk (artifact cleanup)

**Files:**
- Test: `src/store/tickets.test.ts` (existing test "hard delete removes every graph row and the byte subtree" at line 948)

**Interfaces:**
- Consumes: `deleteTicket(store, ticketId, graphBytesRoot)` — existing signature
- Produces: Same; verifies workspace directory is cleaned up

- [ ] **Step 1: Verify existing test covers workspace cleanup** — The test at line 948 already creates a workspace row and verifies byte subtree removal. Run it to confirm.

Run: `npx vitest run src/store/tickets.test.ts -t "hard delete removes every graph row and the byte subtree"`
Expected: PASS (after Task 1 fix)

- [ ] **Step 2: If not covered, add test for on-disk workspace cleanup** — The existing test seeds a workspace row (line 940-944) and checks the byte directory is removed. This should pass once Task 1 is complete.

- [ ] **Step 3: Commit** (if new test added)

```bash
git add src/store/tickets.test.ts
git commit -m "test(store): verify deleteTicket cleans graph workspace bytes for abandoned runs"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Issue 1 (P1): `deleteTicket` omits `approach_graph_workspaces` → Task 1
- ✅ Issue 2 (P1): impl marker routes on any graph run ignoring approach/status → Task 2
- ✅ Issue 3 (P2): refusal message is a dead end → Task 3
- ❌ Issue 4 (P2): gate failures from stale deps — out of scope (gate runner infrastructure)
- ❌ Issue 5 (P3): manifest warning noise — out of scope (CLI output channel)

**2. Placeholder scan:**
- ✅ No "TBD", "TODO", "implement later"
- ✅ No "add appropriate error handling" without code
- ✅ No "Write tests for the above" without actual test code
- ✅ All code blocks have actual implementation
- ✅ All types, signatures, and property names match across tasks

**3. Type consistency:**
- ✅ `BUILT_IN_PACKAGE_ID` used consistently (imported from `../approaches/builtInId.ts`)
- ✅ `TERMINAL_GRAPH_RUN_STATUSES` already defined in `graphMarkerGuard.ts` — reused
- ✅ `graphRunNotMarkerReadyMessage` signature unchanged (returns string)
- ✅ `runStageCommand` signature unchanged
- ✅ `deleteTicket` signature unchanged

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-03-abandoned-graph-run-strands-a.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**