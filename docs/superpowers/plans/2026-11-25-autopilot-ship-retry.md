# Autopilot Ship Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Autopilot is on for a ticket whose ship a person already confirmed, Autopilot itself re-runs that ship after a failure that is only a GitHub server error, with backoff (2/5/10/20/30 min) and a bound of 5 retries.

**Architecture:** One pure decision module reads the ship history (`ship_runs`, `ship_repo_steps`, `ship_operation_intents`) plus two injected worktree seams and returns `retry | wait | park | none`. `autopilotTick` calls it only when the ship stage is `failed` and unblocked, after the existing controller/session/drain guards. The retry runs through the Retry ship path (`runShipSaga(ticketId, false, { repos })`), bound in `extension.ts`, never through `unattended`. No schema change: the budget comes from the run history.

**Tech Stack:** TypeScript (ESM), better-sqlite3 store, vitest, Superpowers plan workflow.

**Spec:** Ticket `FEAT-AUTOPILOT-RETRY-A-CONFIRMED` (T1362), design constraints `@arch:AP-00`, `@arch:AP-06`, `@arch:AC-37`, `@arch:SHIP-RESUME`, `@arch:GH-08`, `@arch:EVENTS`, D838 (`isGitHubServerError`), T1356.

## Global Constraints

- `vscode` is not a runtime dependency: all logic under `src/store/**` and `src/extension/ops/**` is host-agnostic and testable under vitest with fakes.
- Nothing on the extension-host path may use `spawnSync`; worktree reads go through an injected async `git` runner.
- Never retry without an attended (`ship_runs.unattended = 0`) ship run at or before the newest failed run.
- Never retry when a worktree is dirty, unreadable, or its HEAD differs from the head the confirmed ship intended to push.
- At most 5 automatic retries; then one Karst event `auto-fix stopped: GitHub server error, ship retried 5/5`, no ship block, and `Retry ship` stays the way out.
- Only `isGitHubServerError` texts are retried, and only on `push`/`pr` steps.
- Karst events (never bulletin notes) for the retry and the stop; debug lines start with `[ship] autopilot`.
- Keep `src/extension/ops/autopilotShipRetry.ts` under ~150 lines.
- Commits are conventional commits; tests are added before the code (RED → GREEN).

---

### Task 1: Store reads for the ship run history

**Files:**
- Modify: `src/store/shipRuns.ts` (append after `countShipRuns`, around line 1021)
- Test: `src/store/shipRuns.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `RUN_SELECT`, `STEP_SELECT`, `rowToShipRun`, `rowToShipRepoStep`, `parseShipPreState` (all in the same file).
- Produces:
  - `listShipRuns(store: Store, ticketId: number, limit?: number): ShipRun[]` — newest first (`ORDER BY id DESC`).
  - `listShipRepoSteps(store: Store, shipRunId: number): ShipRepoStep[]` — insertion order.
  - `newestPushIntentHead(store: Store, ticketId: number, repo: string): string | null` — `localHead` of the newest `push` intent of that repo, whatever its status; null when there is none or the pre-state is unreadable.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/shipRuns.test.ts`:

```ts
describe('run history reads (T1362)', () => {
  it('lists a ticket\'s runs newest first, capped', () => {
    const ticket = createTicket(store, { key: 'SHIP-HIST', title: 't' });
    const first = openShipRun(store, { ticketId: ticket.id, attempt: 1, startedAt: '2026-11-25T10:00:00.000Z' });
    closeShipRun(store, first.id, 'failed', '2026-11-25T10:01:00.000Z');
    const second = openShipRun(store, { ticketId: ticket.id, attempt: 2, startedAt: '2026-11-25T10:02:00.000Z' });
    closeShipRun(store, second.id, 'passed', '2026-11-25T10:03:00.000Z');
    expect(listShipRuns(store, ticket.id).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(listShipRuns(store, ticket.id, 1).map((r) => r.id)).toEqual([second.id]);
  });

  it('lists every step row of one run in insertion order', () => {
    const ticket = createTicket(store, { key: 'SHIP-STEPS', title: 't' });
    const run = openShipRun(store, { ticketId: ticket.id, attempt: 1, startedAt: '2026-11-25T10:00:00.000Z' });
    const push = openShipRepoStep(store, { shipRunId: run.id, repo: 'r', step: 'push', detail: 'push', startedAt: '2026-11-25T10:00:00.000Z' });
    const pr = openShipRepoStep(store, { shipRunId: run.id, repo: 'r', step: 'pr', detail: 'pr', startedAt: '2026-11-25T10:00:01.000Z' });
    finishShipRepoStep(store, pr.id, { status: 'failed', detail: 'HTTP 502', endedAt: '2026-11-25T10:00:02.000Z' });
    expect(listShipRepoSteps(store, run.id).map((s) => [s.id, s.step, s.status])).toEqual([[push.id, 'push', 'running'], [pr.id, 'pr', 'failed']]);
  });

  it('reads the head the newest push intent intended, whatever its status', () => {
    const ticket = createTicket(store, { key: 'SHIP-HEAD', title: 't' });
    const run = openShipRun(store, { ticketId: ticket.id, attempt: 1, startedAt: '2026-11-25T10:00:00.000Z' });
    const prep = (key: string, localHead: string, at: string) =>
      beginShipOperationPreparation(store, {
        shipRunId: run.id, repo: 'r', step: 'push', operationKey: key, createdAt: at,
        preState: { step: 'push', localHead, remote: 'origin', ref: 'b', preRemoteHead: null },
      });
    prep('push-old', 'a'.repeat(40), '2026-11-25T10:00:00.000Z');
    prep('push-new', 'b'.repeat(40), '2026-11-25T10:00:01.000Z');
    expect(newestPushIntentHead(store, ticket.id, 'r')).toBe('b'.repeat(40));
    expect(newestPushIntentHead(store, ticket.id, 'other')).toBeNull();
  });
});
```

Add the three new names to the existing import from `./shipRuns.js` in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/shipRuns.test.ts`
Expected: FAIL — `listShipRuns` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/store/shipRuns.ts`, right after `countShipRuns`:

```ts
/**
 * A ticket's ship runs, newest first. `listShipEvidence` keeps only the LATEST
 * run; the ship retry after a GitHub server error (@arch:AP-11) reads the
 * history to know the backoff and the bound.
 */
export function listShipRuns(store: Store, ticketId: number, limit = 50): ShipRun[] {
  return store.db
    .prepare(`${RUN_SELECT} WHERE ticket_id = ? ORDER BY id DESC LIMIT ?`)
    .all(ticketId, limit)
    .map((r) => rowToShipRun(r as ShipRunRowShape));
}

/** Every step row of one ship run, in insertion order. */
export function listShipRepoSteps(store: Store, shipRunId: number): ShipRepoStep[] {
  return store.db
    .prepare(`${STEP_SELECT} WHERE ship_run_id = ? ORDER BY id`)
    .all(shipRunId)
    .map((r) => rowToShipRepoStep(r as ShipRepoStepRowShape));
}

/**
 * The `localHead` of the NEWEST `push` intent of a ticket + repo, whatever its
 * status: the head the ship that ended intended to push. A retry re-pushes that
 * exact head, so a HEAD that moved means new work and no retry (@arch:AP-11).
 * Null when karst never prepared a push for the repo, or the row is unreadable.
 */
export function newestPushIntentHead(store: Store, ticketId: number, repo: string): string | null {
  const row = store.db
    .prepare(
      `SELECT i.pre_state_json AS pre
         FROM ship_operation_intents i
         JOIN ship_runs r ON r.id = i.ship_run_id
        WHERE r.ticket_id = ? AND i.repo = ? AND i.step = 'push'
        ORDER BY i.id DESC LIMIT 1`,
    )
    .get(ticketId, repo) as { pre: string } | undefined;
  if (row === undefined) return null;
  const pre = parseShipPreState(row.pre, 'push');
  return pre !== null && pre.step === 'push' && pre.localHead !== '' ? pre.localHead : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/shipRuns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/shipRuns.ts src/store/shipRuns.test.ts
git commit -m "feat(store): read a ticket's ship run history and its newest push head"
```

---

### Task 2: The ship-retry decision module

**Files:**
- Create: `src/extension/ops/autopilotShipRetry.ts`
- Test: `src/extension/ops/autopilotShipRetry.test.ts`

**Interfaces:**
- Consumes: `getTicket`, `getStage`, `stageBlock`, `listShipRuns`, `listShipRepoSteps`, `newestPushIntentHead`, `isGitHubServerError`, `planRetryShip`.
- Produces:
  ```ts
  export const AUTO_SHIP_RETRY_DELAYS_MS: readonly number[]; // [120000, 300000, 600000, 1200000, 1800000]
  export const MAX_AUTO_SHIP_RETRIES: number;                  // 5
  export const AUTO_SHIP_RETRY_STOP_REASON: string;           // 'auto-fix stopped: GitHub server error, ship retried 5/5'
  export interface ShipRetrySeams {
    worktreeClean(repo: string): Promise<{ ok: true; clean: boolean } | { ok: false }>;
    localHead(repo: string): Promise<string | null>;
  }
  export type ShipRetryDecision =
    | { kind: 'retry'; repos: readonly string[]; n: number }
    | { kind: 'wait'; until: number }
    | { kind: 'park'; reason: string }
    | { kind: 'none'; why: string };
  export function shipRetryDecision(store: Store, ticketId: number, now: number, seams: ShipRetrySeams): Promise<ShipRetryDecision>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/extension/ops/autopilotShipRetry.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { transition } from '../../workflow/machine.js';
import { beginShipOperationPreparation, closeShipRun, finishShipRepoStep, openShipRepoStep, openShipRun, type ShipStep, type ShipStepStatus } from '../../store/shipRuns.js';
import {
  AUTO_SHIP_RETRY_DELAYS_MS, AUTO_SHIP_RETRY_STOP_REASON, shipRetryDecision,
  type ShipRetrySeams,
} from './autopilotShipRetry.js';

const MIN = 60_000;
const ENDED = '2026-11-25T12:00:00.000Z';
const NOW = Date.parse(ENDED);
const HEAD = 'a'.repeat(40);

let store: Store;
let id: number;

/** A ticket at ship whose newest ship step failed, with no block. */
function failedShip(endedAt = ENDED): void {
  setStage(store, id, 'ship', { status: 'failed', verdict: 'ship failed', endedAt });
}

function run(opts: {
  status?: 'failed' | 'passed';
  unattended?: boolean;
  endedAt?: string;
  steps?: Array<[ShipStep, ShipStepStatus, string]>;
  head?: string | null;
} = {}): number {
  const endedAt = opts.endedAt ?? ENDED;
  const started = new Date(Date.parse(endedAt) - MIN).toISOString();
  const r = openShipRun(store, { ticketId: id, attempt: 1, startedAt: started, unattended: opts.unattended === true });
  for (const [step, status, detail] of opts.steps ?? [['pr', 'failed', 'gh: HTTP 502 Bad Gateway'] as const]) {
    const s = openShipRepoStep(store, { shipRunId: r.id, repo: 'r', step, detail: 'run', startedAt: started });
    finishShipRepoStep(store, s.id, { status, detail, endedAt });
  }
  if (opts.head !== null) {
    beginShipOperationPreparation(store, {
      shipRunId: r.id, repo: 'r', step: 'push', operationKey: `push-${r.id}`, createdAt: started,
      preState: { step: 'push', localHead: opts.head ?? HEAD, remote: 'origin', ref: 'b', preRemoteHead: null },
    });
  }
  if ((opts.status ?? 'failed') !== 'failed' || opts.status === 'passed') closeShipRun(store, r.id, 'passed', endedAt);
  else closeShipRun(store, r.id, 'failed', endedAt);
  return r.id;
}

const seams = (over: Partial<ShipRetrySeams> = {}): ShipRetrySeams => ({
  worktreeClean: vi.fn(async () => ({ ok: true as const, clean: true })),
  localHead: vi.fn(async () => HEAD),
  ...over,
});

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'SR-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-11-25T11:00:00.000Z' });
});

describe('shipRetryDecision', () => {
  it('retries the newest server-error run once its backoff elapses', async () => {
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual({ kind: 'wait', until: NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]! });
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]! - 1, seams())).toEqual({ kind: 'wait', until: NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]! });
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('does not retry a ship that is not failed, is running, or has a block', async () => {
    run();
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none'); // stage still passed
    setStage(store, id, 'ship', { status: 'running' });
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none');
    failedShip();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked', runAt: ENDED, gates: [] });
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none');
  });

  it('never retries without an attended run at or before the newest failed run', async () => {
    run({ unattended: true });
    failedShip();
    const d = await shipRetryDecision(store, id, NOW + 10 * MIN, seams());
    expect(d).toEqual({ kind: 'none', why: 'no person confirmed a ship' });
  });

  it('retries after an unattended run that follows a person\'s confirm', async () => {
    run({ status: 'passed', unattended: false, endedAt: '2026-11-25T11:00:00.000Z' });
    run({ unattended: true });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('retry');
  });

  it('retries only a push or pr step whose detail is a GitHub server error', async () => {
    run({ steps: [['commit', 'failed', 'gh: HTTP 502']] });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
    store.db.prepare('DELETE FROM ship_operation_intents').run();
    store.db.prepare('DELETE FROM ship_repo_steps').run();
    store.db.prepare('DELETE FROM ship_runs').run();
    run({ steps: [['push', 'failed', 'remote: HTTP 401 Bad credentials']] });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
    store.db.prepare('DELETE FROM ship_operation_intents').run();
    store.db.prepare('DELETE FROM ship_repo_steps').run();
    store.db.prepare('DELETE FROM ship_runs').run();
    run({ steps: [['pr', 'failed', 'No commits between develop and karst/x']] });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
  });

  it('never retries when a worktree is dirty or unreadable, or the HEAD is not the pushed head', async () => {
    run();
    failedShip();
    const at = NOW + 10 * MIN;
    expect((await shipRetryDecision(store, id, at, seams({ worktreeClean: async () => ({ ok: true, clean: false }) }))).kind).toBe('none');
    expect((await shipRetryDecision(store, id, at, seams({ worktreeClean: async () => ({ ok: false }) }))).kind).toBe('none');
    expect((await shipRetryDecision(store, id, at, seams({ localHead: async () => 'b'.repeat(40) }))).kind).toBe('none');
    expect((await shipRetryDecision(store, id, at, seams({ localHead: async () => null }))).kind).toBe('none');
  });

  it('reads the repos planRetryShip names and retries each one', async () => {
    run({ steps: [['push', 'failed', 'HTTP 503 Service Unavailable'], ['pr', 'passed', 'ok']] });
    failedShip();
    const d = await shipRetryDecision(store, id, NOW + 10 * MIN, seams());
    expect(d).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('backs off 2/5/10/20/30 minutes and parks after the fifth retry', async () => {
    for (const delay of AUTO_SHIP_RETRY_DELAYS_MS) {
      // The newest run's backoff decides the wait; older runs only add to n.
      run();
      failedShip();
      expect(await shipRetryDecision(store, id, NOW + delay - 1, seams())).toEqual({ kind: 'wait', until: NOW + delay });
    }
    const n = 5;
    expect(n).toBe(AUTO_SHIP_RETRY_DELAYS_MS.length);
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual({ kind: 'park', reason: AUTO_SHIP_RETRY_STOP_REASON });
    expect(AUTO_SHIP_RETRY_STOP_REASON).toBe('auto-fix stopped: GitHub server error, ship retried 5/5');
  });

  it('resets the count when a passed run or a non-server-error failure sits in between', async () => {
    run(); // 1
    run(); // 2
    run({ status: 'passed', endedAt: '2026-11-25T11:30:00.000Z' });
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
    run({ steps: [['pr', 'failed', 'HTTP 401 Bad credentials']] });
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('waits for the newest run\'s end time, and never retries a run without one', async () => {
    run();
    failedShip(ENDED);
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('retry');
    store.db.prepare('UPDATE ship_runs SET ended_at = NULL').run();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/extension/ops/autopilotShipRetry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/extension/ops/autopilotShipRetry.ts`:

```ts
import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { listShipRuns, listShipRepoSteps, newestPushIntentHead, type ShipRun } from '../../store/shipRuns.js';
import { isGitHubServerError } from '../../integrations/githubServerError.js';
import { planRetryShip } from '../../ui/dashboard/insideActions.js';

/**
 * Autopilot retries a ship a person already confirmed when every failure of its newest run is a GitHub server error
 * (D838): the person's Confirm/Retry ship is the consent, so the retry repeats the SAME ship and publishes nothing new.
 * The budget comes from the run history, so no schema and no new budget kind is needed (@arch:AP-11).
 */

/** The wait before automatic retry n (1-based): 2, 5, 10, 20 and 30 minutes after the newest failed run ended. */
export const AUTO_SHIP_RETRY_DELAYS_MS: readonly number[] = [2, 5, 10, 20, 30].map((m) => m * 60_000);

/** How many automatic retries one outage gets before Autopilot stops. */
export const MAX_AUTO_SHIP_RETRIES = AUTO_SHIP_RETRY_DELAYS_MS.length;

/** The one stop line of rule 6. No block is written: the failed stage keeps its Retry ship. */
export const AUTO_SHIP_RETRY_STOP_REASON = `auto-fix stopped: GitHub server error, ship retried ${MAX_AUTO_SHIP_RETRIES}/${MAX_AUTO_SHIP_RETRIES}`;

/**
 * The worktree reads of rule 5, injected so tests use fakes. An unreadable state (a failed `git`, no worktree) is never
 * a pass: it does not retry.
 */
export interface ShipRetrySeams {
  /** `git status --porcelain -uall`: `ok: false` when the state cannot be read. */
  readonly worktreeClean: (repo: string) => Promise<{ readonly ok: true; readonly clean: boolean } | { readonly ok: false }>;
  /** The worktree HEAD of the repo, or null when it cannot be read. */
  readonly localHead: (repo: string) => Promise<string | null>;
}

export type ShipRetryDecision =
  | { readonly kind: 'retry'; readonly repos: readonly string[]; readonly n: number }
  | { readonly kind: 'wait'; readonly until: number }
  | { readonly kind: 'park'; readonly reason: string }
  | { readonly kind: 'none'; readonly why: string };

const none = (why: string): ShipRetryDecision => ({ kind: 'none', why });

/** Rule 4: the run failed, and EVERY failed step is a push/pr step whose detail is a GitHub server error. */
function serverErrorOnly(store: Store, run: ShipRun): boolean {
  const failed = listShipRepoSteps(store, run.id).filter((s) => s.status === 'failed');
  return failed.length > 0 && failed.every((s) => (s.step === 'push' || s.step === 'pr') && isGitHubServerError(s.detail));
}

/**
 * The ship-retry decision (@arch:AP-11): a failed, unblocked ship stage; a person's confirmed run at or before the newest
 * failed run; a newest run that failed only on GitHub server errors; nothing new to publish; and the backoff elapsed.
 * Store reads only, plus the injected worktree seams.
 */
export async function shipRetryDecision(store: Store, ticketId: number, now: number, seams: ShipRetrySeams): Promise<ShipRetryDecision> {
  if (getTicket(store, ticketId).stageCurrent !== 'ship') return none('the ticket is not at ship');
  const stage = getStage(store, ticketId, 'ship');
  if (stage === null || stage.status !== 'failed') return none('the ship stage is not failed');
  if (stageBlock(store, ticketId, 'ship') !== null) return none('the ship stage has a block');
  // The budget scans a few runs past the bound: one more than the cap is enough to read `n > MAX`.
  const runs = listShipRuns(store, ticketId, MAX_AUTO_SHIP_RETRIES + 2);
  const newest = runs[0];
  if (newest === undefined || newest.status !== 'failed') return none('the newest ship run did not fail');
  // Rule 3: the person's Confirm/Retry ship opened the run that failed (or an earlier one of the same ship).
  if (!runs.some((r) => !r.unattended && r.id <= newest.id)) return none('no person confirmed a ship');
  if (!serverErrorOnly(store, newest)) return none('the failed ship was not a GitHub server error');
  // Rule 5: nothing new would be published. The repos Retry ship would re-run must hold exactly the pushed head.
  const plan = planRetryShip(store, ticketId);
  if ('reason' in plan) return none(plan.reason);
  for (const repo of plan.repos) {
    const state = await seams.worktreeClean(repo).catch((): { ok: false } => ({ ok: false }));
    if (!state.ok) return none(`the worktree of ${repo} cannot be read`);
    if (!state.clean) return none(`the worktree of ${repo} has uncommitted changes`);
    const head = await seams.localHead(repo).catch(() => null);
    const pushed = newestPushIntentHead(store, ticketId, repo);
    if (head === null || pushed === null || head !== pushed) return none(`the head of ${repo} is not the head the ship pushed`);
  }
  // Rule 6: count the consecutive newest runs that failed only on server errors. A passed run or another failure stops it.
  let n = 0;
  for (const r of runs) {
    if (r.status !== 'failed' || !serverErrorOnly(store, r)) break;
    n += 1;
  }
  if (n > MAX_AUTO_SHIP_RETRIES) return { kind: 'park', reason: AUTO_SHIP_RETRY_STOP_REASON };
  const endedAt = newest.endedAt === null ? Number.NaN : Date.parse(newest.endedAt);
  if (Number.isNaN(endedAt)) return none('the newest failed ship run has no end time');
  const until = endedAt + AUTO_SHIP_RETRY_DELAYS_MS[n - 1]!;
  if (now < until) return { kind: 'wait', until };
  return { kind: 'retry', repos: plan.repos, n };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/extension/ops/autopilotShipRetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/autopilotShipRetry.ts src/extension/ops/autopilotShipRetry.test.ts
git commit -m "feat(autopilot): decide a ship retry after a GitHub server error"
```

---

### Task 3: Wire the decision into `autopilotTick` and the sweep

**Files:**
- Modify: `src/extension/ops/autopilotOps.ts` (`AutopilotDeps`, `AutopilotResult`, `autopilotTick`, new `shipRetryStep`, new `shipRetryNoted`)
- Modify: `src/extension/ops/autopilotWiring.ts` (`TicketSeams`, `autopilotSweep` pass-through and `acted` count)
- Test: `src/extension/ops/autopilotOps.test.ts`, `src/extension/ops/autopilotWiring.test.ts`

**Interfaces:**
- Consumes: `shipRetryDecision`, `MAX_AUTO_SHIP_RETRIES`, `ShipRetrySeams`, `ShipRetryOutcome` (Task 2).
- Produces:
  - `AutopilotDeps.retryShip?: (repos: readonly string[]) => Promise<ShipRetryOutcome>`
  - `AutopilotDeps.shipRetry?: ShipRetrySeams`
  - `AutopilotResult` member `{ kind: 'shipRetried' }`
  - `TicketSeams.retryShip?`, `TicketSeams.shipRetry?`
  - `export type ShipRetryOutcome = { kind: 'sent' } | { kind: 'busy' }` (in `autopilotShipRetry.ts`)

- [ ] **Step 1: Write the failing tests**

In `src/extension/ops/autopilotOps.test.ts`, add a `describe('the ship retry after a GitHub server error')` that seeds a failed, unblocked ship with one failed `pr` step (`HTTP 502`), a push intent, one attended run:

```ts
import { beginShipOperationPreparation, closeShipRun, finishShipRepoStep, openShipRepoStep, openShipRun } from '../../store/shipRuns.js';
import { AUTO_SHIP_RETRY_STOP_REASON } from './autopilotShipRetry.js';

function failedServerErrorShip(endedAt = '2026-11-25T12:00:00.000Z', runs = 1): void {
  setStage(store, id, 'ship', { status: 'failed', endedAt });
  store.db.prepare('UPDATE stages SET blocked_kind = NULL, blocked_reason = NULL, blocked_at = NULL WHERE ticket_id = ?').run(id);
  for (let i = 0; i < runs; i += 1) {
    const r = openShipRun(store, { ticketId: id, attempt: i + 1, startedAt: '2026-11-25T11:59:00.000Z' });
    const s = openShipRepoStep(store, { shipRunId: r.id, repo: 'r', step: 'pr', detail: 'run', startedAt: '2026-11-25T11:59:00.000Z' });
    finishShipRepoStep(store, s.id, { status: 'failed', detail: 'gh: HTTP 502 Bad Gateway', endedAt });
    beginShipOperationPreparation(store, { shipRunId: r.id, repo: 'r', step: 'push', operationKey: `push-${r.id}`, createdAt: '2026-11-25T11:59:00.000Z', preState: { step: 'push', localHead: 'a'.repeat(40), remote: 'origin', ref: 'b', preRemoteHead: null } });
    closeShipRun(store, r.id, 'failed', endedAt);
  }
}
const retrySeams = (head = 'a'.repeat(40)) => ({ shipRetry: { worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => head } });

it('retries the confirmed ship after the backoff and records one event', async () => {
  failedServerErrorShip();
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  const r = rig({ now: () => Date.parse('2026-11-25T12:10:00.000Z'), retryShip, ...retrySeams() });
  expect(await autopilotTick(r.deps)).toEqual({ kind: 'shipRetried' });
  expect(retryShip).toHaveBeenCalledWith(['r']);
  expect(r.notes).toEqual([['Autopilot: retried ship after a GitHub server error (1/5)', expect.stringContaining('Retry ship')]]);
  expect(r.debug).toHaveBeenCalledWith(expect.stringContaining('[ship] autopilot'));
});

it('waits before the backoff, with one debug line per armed wait', async () => {
  failedServerErrorShip();
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  const r = rig({ now: () => Date.parse('2026-11-25T12:00:30.000Z'), retryShip, ...retrySeams() });
  expect((await autopilotTick(r.deps)).kind).toBe('idle');
  expect((await autopilotTick(r.deps)).kind).toBe('idle');
  expect(retryShip).not.toHaveBeenCalled();
  expect(r.debug.mock.calls.filter(([m]) => String(m).includes('the ship retry waits')).length).toBe(1);
});

it('stops after 5 retries: one event, no block, no sixth retry', async () => {
  failedServerErrorShip(undefined, 6);
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  const r = rig({ now: () => Date.parse('2026-11-25T12:59:00.000Z'), retryShip, ...retrySeams() });
  expect((await autopilotTick(r.deps)).kind).toBe('idle');
  expect((await autopilotTick(r.deps)).kind).toBe('idle');
  expect(retryShip).not.toHaveBeenCalled();
  expect(stageBlock(store, id, 'ship')).toBeNull();
  expect(r.notes).toEqual([['Autopilot: ' + AUTO_SHIP_RETRY_STOP_REASON, expect.any(String)]]);
});

it('does not retry with the Autopilot off, another controller, a session, or no seam', async () => {
  failedServerErrorShip();
  const at = Date.parse('2026-11-25T12:10:00.000Z');
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  expect((await autopilotTick(rig({ now: () => at, retryShip, ...retrySeams(), config: () => ({ ...CFG, enabled: false }) }).deps)).kind).toBe('off');
  expect((await autopilotTick(rig({ now: () => at, retryShip, ...retrySeams(), controls: () => false }).deps)).kind).toBe('not-controller');
  expect((await autopilotTick(rig({ now: () => at, retryShip, ...retrySeams(), sessionRunning: () => true }).deps)).kind).toBe('busy');
  expect((await autopilotTick(rig({ now: () => at, retryShip }).deps)).kind).toBe('idle');
  expect(retryShip).not.toHaveBeenCalled();
});
```

Note the `rig()` deps type in that file spreads `...over`, so `retryShip`/`shipRetry`/`now` flow through.

In `src/extension/ops/autopilotWiring.test.ts`, add:

```ts
it('passes the ship-retry seams to the tick and counts a ship retry as acted (T1362)', async () => {
  const { store, projectId, id } = shipTicket();
  setStage(store, id, 'ship', { status: 'failed', endedAt: '2026-11-25T12:00:00.000Z' });
  // (seed a failed pr step with a server error and one attended run as in autopilotOps.test.ts)
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  const changed = vi.fn();
  const acted = await autopilotSweep({
    store, projectId: () => projectId, manifest: () => ({ autopilot: cfg }) as never,
    caps: () => ({ perParent: 2, total: 4 }),
    seamsFor: () => seams({ retryShip, shipRetry: { worktreeClean: async () => ({ ok: true, clean: true }), localHead: async () => 'a'.repeat(40) } }),
    debug: () => {}, changed,
  });
  expect(acted).toBe(1);
  expect(retryShip).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
});
```

The sweep has no clock seam today: add an optional `now?: () => number` to `AutopilotSweepDeps` and pass it to the tick, so the test can put the clock past the backoff. (Keep it optional; the binding leaves it unset.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotWiring.test.ts`
Expected: FAIL — no `retryShip` seam, no `shipRetried` result.

- [ ] **Step 3: Write the implementation**

In `src/extension/ops/autopilotShipRetry.ts`, add the outcome type:

```ts
/** What the Retry ship seam reports: the saga started (`runShipSaga` records its own failure), or the host drains. */
export type ShipRetryOutcome = { readonly kind: 'sent' } | { readonly kind: 'busy' };
```

In `src/extension/ops/autopilotOps.ts`:

1. Import `AUTO_SHIP_RETRY_STOP_REASON, AUTO_SHIP_RETRY_DELAYS_MS, MAX_AUTO_SHIP_RETRIES, shipRetryDecision, type ShipRetryOutcome, type ShipRetrySeams` from `./autopilotShipRetry.js`.
2. Add to `AutopilotDeps`:

```ts
  /**
   * Re-runs a confirmed ship for the repos Retry ship would name, after a failure that was only a GitHub server error
   * (@arch:AP-11). Absent: no retry.
   */
  readonly retryShip?: (repos: readonly string[]) => Promise<ShipRetryOutcome>;
  /** The worktree reads of that retry. Absent: no retry. */
  readonly shipRetry?: ShipRetrySeams;
```

3. Add `| { readonly kind: 'shipRetried' }` to `AutopilotResult`.
4. In `autopilotTick`, capture the stage and insert the failed-ship branch:

```ts
  // A ship saga in flight owns the ticket: no round while it runs.
  const shipStage = getStage(d.store, d.ticketId, 'ship');
  if (shipStage?.status === 'running') return { kind: 'busy' };
  ...
  const blockKind = stageBlock(d.store, d.ticketId, 'ship')?.kind;
  // A failed ship with NO block is the other state Autopilot works: a retry of a person's confirmed ship that failed
  // only on a GitHub server error (@arch:AP-11). Every other foreign block still needs a person.
  const failedShip = blockKind === null && shipStage?.status === 'failed';
  if (!failedShip && blockKind !== 'awaiting-merge' && blockKind !== 'base-moved-failed') return { kind: 'idle' };
  ...
  if (d.sessionRunning() || ticket.agentState === 'running') return { kind: 'busy' };
  if (failedShip) return guardedRound(d, () => shipRetryStep(d));
```

5. Add the step and its dedupe map:

```ts
/** Waits and stops already announced for the ship retry, per armed state (one line per state, not one per 2 s tick). */
const shipRetryNotedByStore = new WeakMap<Store, Set<string>>();

function shipRetryNoted(store: Store): Set<string> {
  let set = shipRetryNotedByStore.get(store);
  if (!set) { set = new Set(); shipRetryNotedByStore.set(store, set); }
  return set;
}

/**
 * The failed-ship branch of the tick (@arch:AP-11): retry a confirmed ship that failed only on a GitHub server error, wait
 * for its backoff, or stop once the bound is spent. The stop writes no block: the failed stage keeps its Retry ship, and
 * a person's Retry ship or Ship click opens a newer run that resets the count.
 */
async function shipRetryStep(d: AutopilotDeps): Promise<AutopilotResult> {
  if (!d.shipRetry || !d.retryShip) return { kind: 'idle' };
  const seen = shipRetryNoted(d.store);
  const decision = await shipRetryDecision(d.store, d.ticketId, (d.now ?? Date.now)(), d.shipRetry);
  switch (decision.kind) {
    case 'none':
      d.debug(`${LOG} ticket ${d.key}: no ship retry (${decision.why})`);
      return { kind: 'idle' };
    case 'wait': {
      const key = `${flightKeyOf(d)}:ship-retry:${decision.until}`;
      if (!seen.has(key)) {
        seen.add(key);
        d.debug(`${LOG} ticket ${d.key}: the ship retry waits until ${new Date(decision.until).toISOString()}`);
      }
      return { kind: 'idle' };
    }
    case 'park': {
      const newest = listShipRuns(d.store, d.ticketId, 1)[0];
      const key = `${flightKeyOf(d)}:ship-retry-park:${newest?.id ?? 0}`;
      if (!seen.has(key)) {
        seen.add(key);
        d.note(`Autopilot: ${decision.reason}`, `${d.key}: every ship run since the person's confirm failed on a GitHub server error; the failed ship keeps its Retry ship.`);
        d.debug(`${LOG} ticket ${d.key}: ${decision.reason}; no block, Retry ship stays`);
      }
      return { kind: 'idle' };
    }
    case 'retry': {
      seen.clear();
      const outcome = await d.retryShip(decision.repos);
      if (outcome.kind === 'busy') {
        d.debug(`${LOG} ticket ${d.key}: no ship retry, the host drains for a reload`);
        return { kind: 'busy' };
      }
      const n = `${decision.n}/${MAX_AUTO_SHIP_RETRIES}`;
      d.note(`Autopilot: retried ship after a GitHub server error (${n})`, `${d.key}: ran Retry ship for ${decision.repos.join(', ')} after a GitHub server error (retry ${n}).`);
      d.debug(`${LOG} ticket ${d.key}: retried ship after a GitHub server error (${n}) for ${decision.repos.join(', ')}`);
      return { kind: 'shipRetried' };
    }
  }
}
```

Import `listShipRuns` from `../../store/shipRuns.js`. (`AUTO_SHIP_RETRY_DELAYS_MS` is not needed by the tick; do not import it — `MAX_AUTO_SHIP_RETRIES` and `AUTO_SHIP_RETRY_STOP_REASON` are used by the decision module itself, so only the ones the tick prints.)

In `src/extension/ops/autopilotWiring.ts`:

```ts
export interface TicketSeams {
  ...
  /** The worktree reads of the ship retry after a GitHub server error (@arch:AP-11). */
  readonly shipRetry?: ShipRetrySeams;
  /** Re-runs a confirmed ship for the named repos (the Retry ship path). */
  readonly retryShip?: (repos: readonly string[]) => Promise<ShipRetryOutcome>;
}
export interface AutopilotSweepDeps {
  ...
  /** Clock of the ship retry's backoff. Default: `Date.now`. */
  readonly now?: () => number;
}
```

Pass both through in the `autopilotTick({...})` object literal (`...(seams.shipRetry ? { shipRetry: seams.shipRetry } : {})`, `...(seams.retryShip ? { retryShip: seams.retryShip } : {})`, `...(d.now ? { now: d.now } : {})`), and count the new kind:

```ts
if (result.kind === 'armed' || result.kind === 'parked' || result.kind === 'cleared' || result.kind === 'rerun' || result.kind === 'rebased' || result.kind === 'shipRetried') acted += 1;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotWiring.test.ts src/extension/ops/autopilotShipRetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/autopilotOps.ts src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotWiring.ts src/extension/ops/autopilotWiring.test.ts src/extension/ops/autopilotShipRetry.ts
git commit -m "feat(autopilot): retry a confirmed ship that failed on a GitHub server error"
```

---

### Task 4: Bind the retry to the real ship path

**Files:**
- Modify: `src/extension/autopilotBinding.ts` (`AutopilotBindingDeps`, `seamsFor`)
- Modify: `src/extension.ts` (the `startAutopilot({...})` call)
- Test: `src/extension/autopilotBindingSeams.test.ts`

**Interfaces:**
- Consumes: `ShipRetrySeams`, `ShipRetryOutcome`, `TicketSeams.shipRetry`, `TicketSeams.retryShip`.
- Produces:
  ```ts
  export interface AutopilotBindingDeps {
    shipRetry?: (ticketId: number) => ShipRetrySeams;
    retryShip?: (ticketId: number, repos: readonly string[]) => Promise<ShipRetryOutcome>;
  }
  ```

- [ ] **Step 1: Write the failing test**

In `src/extension/autopilotBindingSeams.test.ts`, add:

```ts
it('forwards the ship-retry seams for the ticket (T1362)', async () => {
  const shipRetry = vi.fn(() => ({ worktreeClean: async () => ({ ok: true as const, clean: true }), localHead: async () => 'h' }));
  const retryShip = vi.fn(async () => ({ kind: 'sent' as const }));
  const r = rig({ shipRetry, retryShip });
  const { handle, seams } = open(r);
  expect(seams.shipRetry).toBe(shipRetry.mock.results[0]!.value);
  await expect(seams.retryShip!(['repo-a'])).resolves.toEqual({ kind: 'sent' });
  expect(retryShip).toHaveBeenCalledWith(r.id, ['repo-a']);
  handle.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/extension/autopilotBindingSeams.test.ts`
Expected: FAIL — `shipRetry` is not a binding dep.

- [ ] **Step 3: Write the binding**

In `src/extension/autopilotBinding.ts`, import the types and add the deps:

```ts
import type { ShipRetryOutcome, ShipRetrySeams } from './ops/autopilotShipRetry.js';
...
  /** The worktree reads of the ship retry after a GitHub server error (@arch:AP-11). Absent: no retry. */
  readonly shipRetry?: (ticketId: number) => ShipRetrySeams;
  /** Re-runs a confirmed ship for the named repos through the Retry ship path. Absent: no retry. */
  readonly retryShip?: (ticketId: number, repos: readonly string[]) => Promise<ShipRetryOutcome>;
```

and in `seamsFor`:

```ts
        ...(d.shipRetry ? { shipRetry: d.shipRetry(id) } : {}),
        ...(d.retryShip ? { retryShip: (repos: readonly string[]) => d.retryShip!(id, repos) } : {}),
```

- [ ] **Step 4: Bind it in `extension.ts`**

In the `startAutopilot({...})` call (around line 2104), add:

```ts
    // @arch:AP-11: a confirmed ship that failed only on a GitHub server error is retried through the Retry ship path.
    shipRetry: (id) => {
      const pathOf = new Map(listWorktreesByTicket(localStore, id).map((w) => [w.repo, w.path]));
      const input = ciInput(id);
      return {
        worktreeClean: async (repo) => {
          const cwd = pathOf.get(repo);
          if (cwd === undefined) return { ok: false as const };
          const r = await input.git(['status', '--porcelain', '-uall'], cwd);
          return r.exitCode === 0 ? { ok: true as const, clean: r.stdout.trim() === '' } : { ok: false as const };
        },
        localHead: async (repo) => {
          const cwd = pathOf.get(repo);
          return cwd === undefined ? null : headShaOf(input, cwd);
        },
      };
    },
    retryShip: async (id, repos) => {
      try {
        await runShipSaga(id, false, { repos });
        return { kind: 'sent' as const };
      } catch (e) {
        if (e instanceof ShipDrainingError) return { kind: 'busy' as const };
        // The saga recorded the failure on the ship stage and opened its run: the next tick reads that run.
        logger.debug(`[ship] autopilot ticket ${formatId('ticket', id)}: the ship retry ended (${e instanceof Error ? e.message : String(e)})`);
        return { kind: 'sent' as const };
      }
    },
```

Add `headShaOf` to the existing `from './extension/ops/ciActionsWiring.js'` import (it already imports several names from that module).

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/extension/autopilotBindingSeams.test.ts src/extension/ops/autopilotWiring.test.ts src/extension/ops/autopilotOps.test.ts`
Then: `npm run -s typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/extension/autopilotBinding.ts src/extension/autopilotBindingSeams.test.ts src/extension.ts
git commit -m "feat(autopilot): bind the ship retry to the Retry ship path"
```

---

### Task 5: Document the rule (`@arch:AP-11`)

**Files:**
- Modify: `docs/arch/autopilot.md` (new `@arch:AP-11` block; `@arch:AP-00` rules list and flow)
- Regenerate: `docs/INDEX.md`, `docs/COVERS.json`, `docs/arch/system-map.md`

- [ ] **Step 1: Add the AP-11 block after AP-10**

```markdown
## [@arch:AP-11] Ship retry after a GitHub server error
covers: src/extension/ops/autopilotShipRetry.ts, src/extension/ops/autopilotOps.ts, src/extension/autopilotBinding.ts, src/store/shipRuns.ts#listShipRuns, src/store/shipRuns.ts#listShipRepoSteps, src/store/shipRuns.ts#newestPushIntentHead

Split out of `arch:AP-00` (T1362).

### Rules
- A ship stage that is `failed` with no block is one more state Autopilot works: a person already answered Confirm ship (or Retry ship), so Autopilot repeats the SAME ship instead of waiting for another click. Every other state keeps `@arch:AP-00`: a foreign block, a first ship with no confirm (`@arch:AP-06`), a running ship (busy).
- All of these hold: effective Autopilot mode on; the ticket is not paused and has no stop flag, paused or stopped reason; this window `controls()` the ticket (`@arch:AC-37`); the host is not draining; no session runs; the ship stage is `failed` with no block; a `ship_runs` row with `unattended = 0` exists at or before the newest failed run; EVERY failed `ship_repo_steps` row of that newest run is a `push` or `pr` step whose `detail` matches `isGitHubServerError` (D838); and nothing new would be published.
- Nothing new: for every repo `planRetryShip` returns, `git status --porcelain -uall` exits 0 and is empty, and the worktree HEAD equals the `localHead` of the newest `push` intent of `ship_operation_intents` (whatever its status). An unreadable state (no worktree, a failed git, no push intent) does not retry.
- Budget: count the consecutive newest runs of the ticket that failed only on server errors (a passed run or another failure stops the count). Retry n (1-based) waits `AUTO_SHIP_RETRY_DELAYS_MS[n-1]` (2, 5, 10, 20, 30 minutes) after the `ended_at` of the newest failed run. After 5 retries the engine stops: it writes NO block (the failed stage keeps its Retry ship) and records ONE Karst event `auto-fix stopped: GitHub server error, ship retried 5/5`. A newer run (a person's Retry ship or Ship click, or a later ship) resets the count.
- The retry runs the Retry ship path `runShipSaga(ticketId, false, { repos })` (never `unattended`), so `@arch:SHIP-RESUME`'s crash-loop and delivery rules are unchanged, and a push that GitHub already accepted is a no-op or the lease case of `@arch:GH-08`. The stage reads `running` while it runs, so a second tick returns busy.
- One Karst event per retry `Autopilot: retried ship after a GitHub server error (<n>/5)` and one per stop (`@arch:EVENTS`). Debug lines start with `[ship] autopilot`; a wait is announced once per armed wait, not once per tick.
- Out of scope: a first ship with no confirm, any other failure kind, UI changes (the rail keeps Retry ship) and manifest fields (the delays and the bound are constants).
END_DOC_BLOCK: [@arch:AP-11]
```

- [ ] **Step 2: Reference it from AP-00**

In the `### Rules` list of `@arch:AP-00`, add:

```markdown
- Ship retry after a GitHub server error (T1362): a failed, unblocked ship whose newest run failed only on `isGitHubServerError` texts of `push`/`pr` steps is retried through the Retry ship path with the 2/5/10/20/30-minute backoff and the bound of 5. Rules in `@arch:AP-11`.
```

In the AP-00 `### Flow` mermaid, insert the failed-ship gate:

```mermaid
  G -->|yes| C{conflicted PR}
  C -->|round or auto-deliver runs| X
  C -->|yes| H
  C -->|no| P{allowlisted CI failure}
  P -->|no| F{ship failed, no block}
  F -->|server-error retry armed| N2[Retry ship + Karst event]
  F -->|no| X
  P -->|yes| H{host ticket}
```

- [ ] **Step 3: Regenerate the generated docs and check**

Run:

```bash
npm run -s docs:graph
npm run -s docs:index
npm run -s docs:covers
npm run -s docs:check
```

Expected: all exit 0; `docs/arch/system-map.md`, `docs/INDEX.md`, `docs/COVERS.json` updated.

- [ ] **Step 4: Commit**

```bash
git add docs/arch/autopilot.md docs/arch/system-map.md docs/INDEX.md docs/COVERS.json
git commit -m "docs(arch): rule for the Autopilot ship retry after a GitHub server error"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run every test this change touches**

```bash
npx vitest run src/store/shipRuns.test.ts src/extension/ops/autopilotShipRetry.test.ts src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotWiring.test.ts src/extension/autopilotBindingSeams.test.ts
npm run -s typecheck
npm run -s docs:check
```

Expected: PASS, exit 0.

- [ ] **Step 2: Confirm the acceptance matrix in the tests**

- Failed at `pr` with `HTTP 502`, Autopilot on, attended run, clean worktree, HEAD = pushed head: retry at +2 min, no retry before it.
- Autopilot off / paused / dirty worktree / HEAD moved / unattended-only / `commit` step / `HTTP 401` / `No commits between`: no retry.
- After 5 retries: one stop event, no block, no sixth retry; a passed run in between resets the count.

- [ ] **Step 3: Commit any remaining change and record the impl marker**

```bash
git status --porcelain
node "$KARST_CLI" stage impl pass --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket FEAT-AUTOPILOT-RETRY-A-CONFIRMED
```

## Self-Review

- Spec rule 1 (guards) → the tick's existing `off` / paused / stop / controls / drain / session checks, exercised by Task 3's last test.
- Rules 2–6 → Task 2 (each rule has a test) and Task 3 (park once, no block, event).
- Edits 2–3 → Tasks 3 and 4. Edit 4 (events + debug prefix) → Task 3. Edit 5 (docs) → Task 5.
- Acceptance criteria → Task 6 step 2 maps each to a test in Tasks 2–3.
- Type consistency: `shipRetryDecision`, `ShipRetrySeams`, `ShipRetryOutcome`, `AUTO_SHIP_RETRY_*`, `retryShip`, `shipRetry`, `shipRetried` are used with the same names in every task.
