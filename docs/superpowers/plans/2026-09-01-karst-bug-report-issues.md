# Karst bug report — issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five issues in the DROID-15792 bug report (attachment `pasted-1788270423774.txt`): the two delete/routing P1s, the dead-end refusal message, the stale-shared-deps gate misattribution, and the CLI manifest-notice noise.

**Architecture:** Five contained fixes across the store, the marker CLI, the graph marker guard, the gate runner, and the manifest-load diagnostics surface. Each fix is TDD'd at its existing colocated test file. The P1s change delete ordering and marker routing (both pure store/machine logic, no UI); the gate fix adds a shared npm-lockfile-drift preflight that turns environment drift into a `blocked` (setup) outcome instead of a `failed` verdict; the notice fix gates inert-key notices on the manifest's existing `debug` flag.

**Tech Stack:** TypeScript (ESM, `type:module`, `.js` import suffixes), better-sqlite3 for unit tests (`openStore(':memory:')`), vitest, node:child_process via the existing `runProcess` gate runner.

## Global Constraints

- Host-agnostic invariants (AGENTS.md): logic takes injected interfaces; `vscode` is never a runtime dep. Gate-path code must keep the injected-`debug` callback seam (`opts.debug`/`onDebug`), never a global logger.
- `noUncheckedIndexedAccess` is on — array reads need `!` or a guard.
- Imports need the `.js` suffix. Keep files small; each fix must stay in its existing module (no new architecture).
- Verdicts stay deterministic (exit codes). A dependency-drift preflight must produce a `blocked` outcome, never a `passed`/`failed` verdict, and must not consume a fix attempt.
- The delete loop order is the product deletion contract (v27/Slice-2 T8): graph evidence is removed leaf-first per graph run, and correctness never depends on an `ON DELETE CASCADE`.
- Manifest notices are `LoadedManifestResult.notices`, INFO-level facts kept separate from `warnings`. This plan gates *notices* on `manifest.debug === true`; *warnings* are always written.
- Tests run under `npm run test:unit` (vitest, in-memory SQLite). Single file: `npx vitest run src/path/to.test.ts`.
- Conventional commits; each task commits separately.

---

### Task 1: `deleteTicket` removes `approach_graph_workspaces` (and the test-only ticket rows)

**Files:**
- Modify: `src/store/tickets.ts` (the `TICKET_CHILD_TABLES` list ~line 564 and the per-run graph delete loop ~line 652)
- Test: `src/store/tickets.test.ts` (`seedGraphTicket` ~line 849 and the "hard delete removes every graph row" test ~line 922)

**Interfaces:**
- Consumes: `createGraphRun`, `createPlannerRun`, `createRevision`, `createNodeRun`, `createToken` (already imported in the test), the `approach_graph_workspaces` table (schema v39: `graph_run_id`, `node_run_id` both `INTEGER NOT NULL REFERENCES …` with no `ON DELETE` action).
- Produces: nothing new — `deleteTicket(store, ticketId, graphBytesRoot?, artifactsRoot?)` unchanged. `TICKET_CHILD_TABLES` gains `test_logs` and `test_hooks`.

**Why:** The per-run loop deletes `approach_node_runs` (line 663) but never `approach_graph_workspaces`, whose `node_run_id` FK is `NOT NULL` with no cascade — so the whole delete transaction rolls back with `FOREIGN KEY constraint failed` the moment a ticket has one workspace row, while the UI already reported the delete as done. Audit catch: `test_logs` and `test_hooks` (v42, `ticket_id` column) are ticket-scoped child rows not in `TICKET_CHILD_TABLES`.

- [ ] **Step 1: Write the failing test**

Add a workspace row to `seedGraphTicket` in `src/store/tickets.test.ts` so the existing graph-delete test finally exercises a materialized workspace. Insert after the `approach_node_overrides` insert (after the `nodeRunId` is known):

```ts
    store.db
      .prepare(
        `INSERT INTO approach_graph_workspaces
           (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
         VALUES (?, ?, 'api', '/workspace/api', 256, '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId, nodeRunId);
```

Add `'approach_graph_workspaces'` to the expected-empty table list in the "hard delete removes every graph row" test (currently lines 932-942):

```ts
        'approach_artifact_instances',
        'approach_graph_workspaces',
        'approach_node_runs',
```

Add a new test after that one for the test-only ticket rows:

```ts
  it('deleteTicket removes the test-only ticket-scoped rows (test_logs, test_hooks)', () => {
    const t = createTicket(store, { key: 'T-TEST', title: 't' });
    store.db
      .prepare(
        `INSERT INTO test_logs (ticket_id, level, module, message, recorded_at)
         VALUES (?, 'info', '[test]', 'm', '2026-08-11T00:00:00.000Z')`,
      )
      .run(t.id);
    store.db
      .prepare(
        `INSERT INTO test_hooks (ticket_id, event, recorded_at)
         VALUES (?, 'SessionStart', '2026-08-11T00:00:00.000Z')`,
      )
      .run(t.id);
    deleteTicket(store, t.id);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM test_logs').get() as { n: number }).n).toBe(0);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM test_hooks').get() as { n: number }).n).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: the "hard delete removes every graph row" test FAILS with `FOREIGN KEY constraint failed`, and the new `test_logs`/`test_hooks` test FAILS because both tables still contain the row after delete.

- [ ] **Step 3: Implement the fix**

In `src/store/tickets.ts`, extend `TICKET_CHILD_TABLES` (append the two test-only tables after `ticket_attachments`):

```ts
  'ticket_attachments',
  'test_logs',
  'test_hooks',
] as const;
```

In the per-run graph loop, delete the workspaces ledger BEFORE `approach_node_runs` (it references both `node_runs` and `graph_runs`, so it must go before either is removed). Insert the line between the `approach_artifact_instances` delete and the `approach_node_runs` delete:

```ts
      store.db.prepare('DELETE FROM approach_artifact_instances WHERE graph_run_id = ?').run(graphRunId);
      store.db.prepare('DELETE FROM approach_graph_workspaces WHERE graph_run_id = ?').run(graphRunId);
      store.db.prepare('DELETE FROM approach_node_runs WHERE graph_run_id = ?').run(graphRunId);
```

Also update the doc comment above `deleteTicket` (the "Slice 2 Task 8" parenthetical) to include workspaces in the leaf-first list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: PASS — every graph table including `approach_graph_workspaces` is empty after delete, and `test_logs`/`test_hooks` rows are removed.

- [ ] **Step 5: Commit**

```bash
git add src/store/tickets.ts src/store/tickets.test.ts
git commit -m "fix(store): delete approach_graph_workspaces and test-only rows with the ticket"
```

---

### Task 2: Route the impl marker past a ghost graph run on non-graph tickets

**Files:**
- Modify: `src/cli/stage.ts` (the `stage === 'impl'` routing, lines 206-237)
- Test: `src/cli/stage.test.ts`

**Interfaces:**
- Consumes: `getTicket(store, ticketId): TicketWithStages` (already exported from `../store/tickets.js`), `BUILT_IN_PACKAGE_ID` (already imported in `stage.ts` from `../approaches/builtInId.js`), the `approach_graph_runs` table.
- Produces: unchanged `runStageCommand(store, ticketId, argv, transition?, ticket?): StageKey` — but the graph routing now only applies to graph-approach tickets.

**Why:** `runStageCommand` routes to `graphImplMarkerGuard` whenever *any* `approach_graph_runs` row exists, without checking the ticket's `approach` or the run's status. A `direct` ticket that has a leftover cancelled graph run (a ticket switched approaches mid-flight, or a partial bootstrap) can then never pass `impl` — the guard refuses the cancelled run and there is no CLI exit. `graphApproachMissingRun` already gates the no-run case on `ticket.approach === BUILT_IN_PACKAGE_ID`; the routing predicate must gate the same way so a non-graph ticket falls through to `markImplementDone`. A graph-approach ticket with a terminal run still routes to the guard and stays refused (abandoned graph attempts cannot be quietly bypassed).

- [ ] **Step 1: Write the failing test**

Add to the `describe('runStageCommand')` block in `src/cli/stage.test.ts` (imports needed at the top: `updateTicketFields` from `../store/tickets.js`, `BUILT_IN_PACKAGE_ID` from `../approaches/builtInId.js`):

```ts
  it('a non-graph ticket with a leftover cancelled graph run still advances through the plain impl marker', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-GHOST', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'cancelled', '2026-09-01T00:00:00.000Z')`,
        )
        .run(id);
      const next = runStageCommand(store, id, ['stage', 'impl', 'pass']);
      expect(next).toBe('uat');
      expect(getTicket(store, id).stageCurrent).toBe('uat');
    } finally {
      store.close();
    }
  });

  it('a graph-approach ticket with a cancelled graph run stays refused at impl', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-GRAPH', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      updateTicketFields(store, id, { approach: BUILT_IN_PACKAGE_ID });
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'cancelled', '2026-09-01T00:00:00.000Z')`,
        )
        .run(id);
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /graph marker refused/,
      );
      expect(getTicket(store, id).stageCurrent).toBe('impl');
    } finally {
      store.close();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/stage.test.ts`
Expected: the first new test FAILS with `graph marker refused: graph run 1 is cancelled, not marker-ready`. The second new test also FAILS (today the non-graph direct ticket throws too, but the assertion expects a throw — so this one actually PASSES; the meaningful RED is the first test). Run the whole file: the first test is the RED that drives the change.

- [ ] **Step 3: Implement the fix**

In `src/cli/stage.ts`, add `getTicket` to the imports from the store:

```ts
import { getTicket } from '../store/tickets.js';
```

Replace the `hasGraphRun` block (currently lines 206-232) with an approach-gated predicate:

```ts
  if (stage === 'impl') {
    // The graph marker guard is the ONLY graph/stage boundary. Its routing must
    // apply only to graph-approach tickets: a `direct` ticket with a leftover
    // graph-run row (a mid-flight approach switch, a partial bootstrap) is not
    // a graph ticket, and routing it to the guard would strand it at impl with
    // no exit. The guard's own no-run sibling (`graphApproachMissingRun`)
    // gates on the same approach id for the same reason.
    const isGraphApproach = store.db
      ? getTicket(store, ticketId).approach === BUILT_IN_PACKAGE_ID
      : false;
    const hasGraphRun =
      isGraphApproach &&
      (store.db
        ? (
            store.db
              .prepare('SELECT 1 AS n FROM approach_graph_runs WHERE ticket_id = ? LIMIT 1')
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
```

The `graphApproachMissingRun` fall-through and the `markImplementDone` return below stay unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/stage.test.ts`
Expected: PASS — both new tests plus the existing routing tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stage.ts src/cli/stage.test.ts
git commit -m "fix(cli): route the impl marker past a ghost graph run on non-graph tickets"
```

---

### Task 3: Say a terminal graph run can never become marker-ready

**Files:**
- Modify: `src/workflow/graphMarkerGuard.ts` (the status guard inside `graphImplMarkerGuard`, line 116-118)
- Test: `src/workflow/graphMarkerGuard.test.ts`

**Interfaces:**
- Consumes: `GraphRunRow` (`{ id, status, blocked_reason }`), the run-status vocabulary from `store/graph/transitions.ts` (`planning`, `awaiting-confirmation`, `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`, `closed`, `cancelled`, `stale`).
- Produces: unchanged `graphImplMarkerGuard(store, ticketId): GraphMarkerGuardResult` — only the refusal `reason` text changes.

**Why:** The refusal `graph run N is cancelled, not marker-ready` names the run and stops. It does not say the run is terminal (it will never become marker-ready) nor that a blocked run's `blocked_reason` is the blocker, so the reader hunts for a fix that does not exist. Terminal states are `closed`, `cancelled`, `stale`; a `blocked` run is not terminal but carries the actionable reason.

- [ ] **Step 1: Write the failing test**

Add to `describe('graphImplMarkerGuard')` in `src/workflow/graphMarkerGuard.test.ts`, reusing the existing `markerReadyTicket` helper and flipping the run's status:

```ts
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
  });

  it('names the blocked reason when a run is blocked, not marker-ready', () => {
    const { ticketId } = markerReadyTicket('GM-BLOCKED');
    store.db
      .prepare(
        "UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = 'graph-budget-exhausted' WHERE ticket_id = ?",
      )
      .run(ticketId);
    const result = graphImplMarkerGuard(store, ticketId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('blocked');
    expect(result.reason).toContain('graph-budget-exhausted');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts`
Expected: the first test FAILS (`reason` does not contain `terminal` / `never become marker-ready`); the second FAILS (`reason` does not contain `graph-budget-exhausted`).

- [ ] **Step 3: Implement the fix**

In `src/workflow/graphMarkerGuard.ts`, add a module-level constant and a message builder after the `GraphRunRow` interface:

```ts
/** Run states that will never become `completed-awaiting-impl-marker`. */
const TERMINAL_GRAPH_RUN_STATUSES: ReadonlySet<string> = new Set(['closed', 'cancelled', 'stale']);

/** Name why a non-marker-ready run refuses the impl marker. */
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

Replace the status guard inside `graphImplMarkerGuard`:

```ts
      if (run.status !== 'completed-awaiting-impl-marker') {
        throw new Error(graphRunNotMarkerReadyMessage(run));
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/graphMarkerGuard.test.ts`
Expected: PASS — both new tests plus the existing guard tests.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/graphMarkerGuard.ts src/workflow/graphMarkerGuard.test.ts
git commit -m "fix(workflow): say a terminal graph run can never become marker-ready"
```

---

### Task 4: Block npm script gates on lockfile drift instead of a code verdict

**Files:**
- Create: `src/workflow/gates/depsCheck.ts`
- Test: `src/workflow/gates/depsCheck.test.ts`
- Modify: `src/workflow/stages/uat.ts` (add `checkDeps` to `UatDeps` and the target loop), `src/workflow/stages/review.ts` (same for `ReviewDeps`), `src/workflow/stages/uat.test.ts`, `src/workflow/stages/review.test.ts`

**Interfaces:**
- Consumes: `runProcess(command, args, cwd, options): Promise<ProcessOutcome>` from `./run.js`.
- Produces:
  - `export type NodeDepsCheck = { ok: true } | { ok: false; kind: 'dependency-drift'; reason: string } | { ok: false; kind: 'unreadable'; reason: string }`
  - `export function classifyNpmProblems(output: string): NodeDepsCheck` — pure classifier over `npm ls --json` output.
  - `export async function checkNodeDeps(cwd: string, opts?: { signal?: AbortSignal; onDebug?: (message: string) => void }, run?: typeof runProcess): Promise<NodeDepsCheck>`
  - `UatDeps.checkDeps?: (cwd: string) => Promise<NodeDepsCheck>` and `ReviewDeps.checkDeps?: (cwd: string) => Promise<NodeDepsCheck>` — injected seam, defaulting to `checkNodeDeps`.

**Why:** A karst worktree has no `node_modules` of its own and resolves up to the main checkout's shared tree. When that tree drifted from the worktree's `package-lock.json`, every gate fails identically for every worktree at once — which reads as a pre-existing code regression ("gates failed: unit (be)", TS2305 errors) instead of an environment problem. Run a cheap `npm ls --depth=0 --json` preflight before npm script gates, and when the installed tree is inconsistent with the lockfile, park the stage (`blocked`, no attempt consumed, fixable with `npm install`/`npm ci`) rather than returning a test-failure verdict. The check is skipped when the target declares no `package-lock.json` or has its own local `node_modules` (per-worktree drift is out of scope; the systemic resolve-up case is the target).

- [ ] **Step 1: Write the failing test**

Create `src/workflow/gates/depsCheck.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyNpmProblems, checkNodeDeps } from './depsCheck.js';
import type { ProcessOutcome } from './run.js';

describe('classifyNpmProblems', () => {
  it('passes a clean tree', () => {
    expect(classifyNpmProblems(JSON.stringify({ problems: [] }))).toEqual({ ok: true });
  });

  it('flags missing/invalid deps as dependency drift', () => {
    const out = JSON.stringify({
      problems: [
        'missing: @arcus-team/web-contract@0.5.0, required by web_backend',
        'invalid: @arcus-team/web-contract@0.4.0 node_modules/@arcus-team/web-contract',
      ],
    });
    expect(classifyNpmProblems(out)).toEqual({
      ok: false,
      kind: 'dependency-drift',
      reason: expect.stringContaining('missing: @arcus-team/web-contract@0.5.0'),
    });
  });

  it('ignores extraneous-only problems', () => {
    const out = JSON.stringify({ problems: ['extraneous: debug@4.3.4 node_modules/debug'] });
    expect(classifyNpmProblems(out)).toEqual({ ok: true });
  });

  it('reports unparseable output as unreadable', () => {
    expect(classifyNpmProblems('npm ERR! something broke')).toEqual({
      ok: false,
      kind: 'unreadable',
      reason: 'npm ls output was not parseable JSON',
    });
  });
});

describe('checkNodeDeps', () => {
  it('skips when the target has no package-lock.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-skip-'));
    try {
      const run = vi.fn();
      const result = await checkNodeDeps(dir, {}, run as never);
      expect(result).toEqual({ ok: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when the target has its own node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-local-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'node_modules'));
      const run = vi.fn();
      const result = await checkNodeDeps(dir, {}, run as never);
      expect(result).toEqual({ ok: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when npm ls exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-ok-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'completed',
        exitCode: 0,
        output: JSON.stringify({ problems: [] }),
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports drift when npm ls exits nonzero with problems', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-drift-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'completed',
        exitCode: 1,
        output: JSON.stringify({ problems: ['invalid: x@0.1.0 node_modules/x'] }),
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual({ ok: false, kind: 'dependency-drift' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unreadable when npm could not be spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-unread-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'spawnFailed',
        message: 'npm not found',
        output: '',
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual({ ok: false, kind: 'unreadable', reason: 'npm not found' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/gates/depsCheck.test.ts`
Expected: FAIL — `Cannot find module './depsCheck.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/workflow/gates/depsCheck.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcessOutcome } from './run.js';

/**
 * Whether a target's installed dependency tree can serve its lockfile before
 * npm script gates run. A karst worktree has no `node_modules` of its own and
 * resolves up to the main checkout's shared tree; when that tree drifted from
 * the worktree's `package-lock.json`, every gate fails identically for every
 * worktree at once — which reads as a pre-existing code regression instead of
 * an environment problem. `ok: false` is a SETUP failure: the caller parks
 * (`blocked`, no attempt consumed) rather than returning a test verdict.
 */
export type NodeDepsCheck =
  | { ok: true }
  | { ok: false; kind: 'dependency-drift'; reason: string }
  | { ok: false; kind: 'unreadable'; reason: string };

const DEP_CHECK_TIMEOUT_MS = 3 * 60 * 1_000;
const DEP_CHECK_MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * Classify `npm ls --json` output. npm exits nonzero for a whole family of
 * tree problems; only the ones that break running tests — `missing:`,
 * `invalid:`, conflicts — count as drift. `extraneous:` packages (installed
 * but not in the lockfile) are benign and must not block.
 */
export function classifyNpmProblems(output: string): NodeDepsCheck {
  try {
    const parsed = JSON.parse(output) as { problems?: unknown };
    const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
    const drift = problems.filter((p) => !p.startsWith('extraneous:'));
    if (drift.length === 0) return { ok: true };
    return { ok: false, kind: 'dependency-drift', reason: drift.slice(0, 3).join('; ') };
  } catch {
    return { ok: false, kind: 'unreadable', reason: 'npm ls output was not parseable JSON' };
  }
}

/**
 * Verify the installed tree against the lockfile in `cwd`. Skipped when the
 * target declares no `package-lock.json` (nothing to compare) or has its own
 * local `node_modules` (drift there is per-worktree, not the systemic
 * resolve-up case). `run` is injectable for tests.
 */
export async function checkNodeDeps(
  cwd: string,
  opts: { signal?: AbortSignal; onDebug?: (message: string) => void } = {},
  run: typeof runProcess = runProcess,
): Promise<NodeDepsCheck> {
  if (!existsSync(join(cwd, 'package-lock.json'))) return { ok: true };
  if (existsSync(join(cwd, 'node_modules'))) return { ok: true };
  opts.onDebug?.(`[gate] deps: verifying installed tree against lockfile in ${cwd}`);
  const outcome: ProcessOutcome = await run('npm', ['ls', '--depth=0', '--json'], cwd, {
    signal: opts.signal,
    onDebug: opts.onDebug,
    timeoutMs: DEP_CHECK_TIMEOUT_MS,
    maxOutputBytes: DEP_CHECK_MAX_OUTPUT_BYTES,
  });
  if (outcome.kind === 'completed' && outcome.exitCode === 0) return { ok: true };
  if (outcome.kind === 'completed') return classifyNpmProblems(outcome.output);
  return {
    ok: false,
    kind: 'unreadable',
    reason: outcome.kind === 'spawnFailed' ? outcome.message : 'npm ls did not complete',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/gates/depsCheck.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the preflight into UAT**

In `src/workflow/stages/uat.ts`:
- Add the import: `import { checkNodeDeps, type NodeDepsCheck } from '../gates/depsCheck.js';`
- Add to `UatDeps`: `checkDeps?: (cwd: string) => Promise<NodeDepsCheck>;`
- In `runUat`, after `const runGates = deps.runGates ?? runGateList;` add: `const checkDeps = deps.checkDeps ?? checkNodeDeps;`
- In the target loop, after the malformed-`package.json` block (the `continue` at the end of that block, before `const scripts = ...`), insert:

```ts
    // A dependency tree that drifted from the lockfile is a SETUP failure, not
    // a code verdict: every gate in a resolve-up worktree fails identically at
    // once, which reads as a pre-existing repo regression. Park (no attempt
    // consumed) and name the repair instead of attributing it to the ticket.
    if (resolution.gates.some((g) => g.script !== null)) {
      const depsCheck = await checkDeps(target.path, { signal: opts.signal, onDebug: opts.debug });
      if (!depsCheck.ok) {
        const reason =
          depsCheck.kind === 'dependency-drift'
            ? `${label}: installed dependencies are inconsistent with package-lock.json — ` +
              `${depsCheck.reason} — run 'npm install' (or 'npm ci') in ${target.path}`
            : `${label}: could not verify installed dependencies — ${depsCheck.reason}`;
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: target ${label} ${depsCheck.kind} (${depsCheck.reason})`,
        );
        return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
      }
    }
```

Add `checkDeps: async () => ({ ok: true })` to the `deps()` factory in `src/workflow/stages/uat.test.ts` (so the dozens of existing tests never spawn npm), and add a drift test:

```ts
  it('parks without a verdict when installed deps drifted from the lockfile', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        checkDeps: async () => ({
          ok: false,
          kind: 'dependency-drift',
          reason: 'missing: @arcus-team/web-contract@0.5.0',
        }),
      }),
    );
    expect(res).toEqual({
      kind: 'blocked',
      blocker: 'capability-missing',
      reason: expect.stringContaining("npm install"),
    });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listGateRuns(store, id)).toEqual([]);
  });
```

`listGateRuns` is already imported in the test file. Run `npx vitest run src/workflow/stages/uat.test.ts` — the new test passes and the existing suite still passes (the default `checkDeps` stub keeps real npm out of every other test).

- [ ] **Step 6: Wire the preflight into review**

In `src/workflow/stages/review.ts`, mirror the UAT wiring: add the same import, `checkDeps?: (cwd: string) => Promise<NodeDepsCheck>;` to `ReviewDeps`, `const checkDeps = deps.checkDeps ?? checkNodeDeps;`, and in the target loop after the malformed-`package.json` block (before `const run = await runGates(...)`) insert the same guarded block with `review` in the debug prefix and the same `finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason])`.

Add `checkDeps: async () => ({ ok: true })` to the `deps()` factory in `src/workflow/stages/review.test.ts`, and a drift test mirroring the UAT one (assert `kind: 'blocked'`, blocker `capability-missing`, reason containing `npm install`, ticket still at `review`, no gate rows).

Run `npx vitest run src/workflow/stages/review.test.ts` — new test passes, existing suite passes.

- [ ] **Step 7: Run the full affected suites and commit**

Run: `npx vitest run src/workflow/gates/depsCheck.test.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts`
Expected: PASS.

```bash
git add src/workflow/gates/depsCheck.ts src/workflow/gates/depsCheck.test.ts src/workflow/stages/uat.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.ts src/workflow/stages/review.test.ts
git commit -m "fix(gates): block npm script gates on lockfile drift instead of a code verdict"
```

---

### Task 5: Emit inert-key notices only when manifest debug is on

**Files:**
- Modify: `src/cli/main.ts` (the `context` branch and `loadProjectSlug`)
- Test: `src/cli/main.test.ts`

**Interfaces:**
- Consumes: `Manifest.debug?: boolean` (`manifest/types.ts:554`), `LoadedManifestResult.notices`, the existing `writeManifestDiagnostics` helper.
- Produces: unchanged `runCli(argv): string` and `loadProjectSlug(manifestPath)` — but notices (inert-key facts) are written only when `manifest.debug === true`; `warnings` are always written.

**Why:** Every CLI invocation (`context`, `stage`, `phase`, `test`) reloads the manifest and prints the inert-key notices to stderr — two unactionable lines before every result. Notices are INFO facts, not problems, so they belong on the manifest's existing verbose/debug channel (`debug: true`). Warnings (legacy `services:`, credential-looking `uat.env`) stay always-on.

- [ ] **Step 1: Write the failing test**

In `src/cli/main.test.ts`, update the existing `'writes inert-key notices to stderr, keeping stdout clean JSON'` test so its fixture enables debug (proving notices still surface when debug is on) and add a sibling test proving silence without it. Add `debug: true` to the fixture manifest:

```ts
      `
id: proj3
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
debug: true
repositories:
  backend:
    repoPath: ../backend
uat:
  secrets:
    - API_KEY
  origins:
    - http://localhost:3000
`,
```

Add a new test after it:

```ts
  it('omits inert-key notices unless manifest debug is on', () => {
    const manifestPath = join(dir, 'quiet.yml');
    writeFileSync(
      manifestPath,
      `
id: proj4
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
uat:
  secrets:
    - API_KEY
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runCli(['context', 'K-1', '--db', dbPath, '--manifest', manifestPath, '--json']);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toContain('not yet active');
    } finally {
      writeSpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/main.test.ts`
Expected: the new `omits inert-key notices unless manifest debug is on` test FAILS (the notice is currently written without debug).

- [ ] **Step 3: Implement the fix**

In `src/cli/main.ts`:

`loadProjectSlug` — write notices only under debug:

```ts
  try {
    const { manifest, warnings, notices } = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(warnings);
    if (manifest.debug === true) writeManifestDiagnostics(notices);
    return manifest.id;
  } catch {
    return undefined;
  }
```

The `context` branch — same gating:

```ts
        const loaded = loadManifestWithDiagnostics(manifestPath);
        writeManifestDiagnostics(loaded.warnings);
        if (loaded.manifest.debug === true) writeManifestDiagnostics(loaded.notices);
        manifest = loaded.manifest;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/main.test.ts src/manifest/inertKeys.test.ts`
Expected: PASS — the debug-gated fixture still writes notices, the no-debug fixture writes none, and the pure `detectInertKeys` unit tests are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/main.test.ts
git commit -m "chore(cli): emit inert-key notices only when manifest debug is on"
```

---

## Self-Review

**1. Spec coverage:**
- Issue #1 (delete omits `approach_graph_workspaces`) → Task 1. The report's "audit the other graph tables" → Task 1 also catches `test_logs`/`test_hooks`; the remaining graph tables are confirmed present in the loop.
- Issue #2 (impl marker routes on any graph run) → Task 2, gated on the ticket's approach; terminal runs on graph tickets stay blocked by design (the report calls this a defensible call).
- Issue #3 (dead-end refusal message) → Task 3.
- Issue #4 (stale shared deps) → Task 4.
- Issue #5 (notice noise) → Task 5.
- The report's "no action needed" items (`stage uat pass` refusal, `rmSync` after-transaction ordering) are left untouched.

**2. Placeholder scan:** Every step carries concrete code or an exact expected message. No TODOs.

**3. Type consistency:** `NodeDepsCheck`/`classifyNpmProblems`/`checkNodeDeps` are defined once in Task 4 and consumed with the same names in the UAT and review wiring and their tests. `checkDeps` is added to both `UatDeps` and `ReviewDeps`. `graphRunNotMarkerReadyMessage(run: GraphRunRow)` uses the existing `GraphRunRow` shape. `updateTicketFields(store, id, { approach })` and `getTicket(store, id).approach` match the existing store API used by `graphApproachMissingRun`.