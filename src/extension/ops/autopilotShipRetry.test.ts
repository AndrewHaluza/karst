import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { removeStage, setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { transition } from '../../workflow/machine.js';
import {
  beginShipOperationPreparation, closeShipRun, finishShipRepoStep, openShipRepoStep, openShipRun,
  type ShipStep,
} from '../../store/shipRuns.js';
import {
  AUTO_SHIP_RETRY_DELAYS_MS, AUTO_SHIP_RETRY_STOP_REASON, isHostTicket, shipRetryDecision,
  type ShipRetryDecision, type ShipRetrySeams,
} from './autopilotShipRetry.js';

const MIN = 60_000;
const ENDED = '2026-11-25T12:00:00.000Z';
const NOW = Date.parse(ENDED);
const HEAD = 'a'.repeat(40);

let store: Store;
let id: number;

/** The ship stage reads failed with no block (a failed ship after the person's confirm). */
function failedShip(endedAt = ENDED): void {
  setStage(store, id, 'ship', { status: 'failed', verdict: 'ship failed', endedAt });
}

interface RunOpts {
  readonly repo?: string;
  readonly status?: 'failed' | 'passed';
  readonly unattended?: boolean;
  readonly endedAt?: string;
  readonly steps?: ReadonlyArray<readonly [ShipStep, 'passed' | 'failed' | 'note', string]>;
  /** `null`: record no push intent for the run. */
  readonly head?: string | null;
}

function run(opts: RunOpts = {}): number {
  const repo = opts.repo ?? 'r';
  const endedAt = opts.endedAt ?? ENDED;
  const started = new Date(Date.parse(endedAt) - MIN).toISOString();
  const r = openShipRun(store, { ticketId: id, attempt: 1, startedAt: started, unattended: opts.unattended === true });
  for (const [step, status, detail] of opts.steps ?? [['pr', 'failed', 'gh: HTTP 502 Bad Gateway'] as const]) {
    const s = openShipRepoStep(store, { shipRunId: r.id, repo, step, detail: 'run', startedAt: started });
    finishShipRepoStep(store, s.id, { status, detail, endedAt });
  }
  if (opts.head !== null) {
    beginShipOperationPreparation(store, {
      shipRunId: r.id, repo, step: 'push', operationKey: `push-${r.id}`, createdAt: started,
      preState: { step: 'push', localHead: opts.head ?? HEAD, remote: 'origin', ref: 'b', preRemoteHead: null },
    });
  }
  closeShipRun(store, r.id, (opts.status ?? 'failed') === 'passed' ? 'passed' : 'failed', endedAt);
  return r.id;
}

const seams = (over: Partial<ShipRetrySeams> = {}): ShipRetrySeams => ({
  worktreeClean: vi.fn(async () => ({ ok: true as const, clean: true })),
  localHead: vi.fn(async () => HEAD),
  ...over,
});

/** The exact `none` answer: every refusal names its reason, so a lost reason is a test failure. */
const none = (why: string): ShipRetryDecision => ({ kind: 'none', why });

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'SR-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-11-25T11:00:00.000Z' });
});

describe('isHostTicket', () => {
  it('is true only for a recorded host placement', async () => {
    await expect(isHostTicket(async () => 'host')).resolves.toBe(true);
    await expect(isHostTicket(async () => 'sandbox')).resolves.toBe(false);
  });

  it('is false when the placement cannot be read', async () => {
    await expect(isHostTicket(async () => { throw new Error('no placement is recorded'); })).resolves.toBe(false);
  });
});

describe('shipRetryDecision', () => {
  it('retries the newest server-error run once its backoff elapses, polling the worktree only then', async () => {
    run();
    failedShip();
    const until = NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!;
    const waiting = seams();
    expect(await shipRetryDecision(store, id, NOW, waiting)).toEqual({ kind: 'wait', until });
    expect(await shipRetryDecision(store, id, until - 1, waiting)).toEqual({ kind: 'wait', until });
    expect(waiting.worktreeClean).not.toHaveBeenCalled();
    expect(waiting.localHead).not.toHaveBeenCalled();
    expect(await shipRetryDecision(store, id, until, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('refuses a ticket that is not at ship', async () => {
    run();
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(id);
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the ticket is not at ship'));
  });

  it('refuses a ship stage that is passed or running', async () => {
    run();
    setStage(store, id, 'ship', { status: 'passed' });
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the ship stage is not failed'));
    setStage(store, id, 'ship', { status: 'running' });
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the ship stage is not failed'));
  });

  it('refuses a ticket with no ship stage row', async () => {
    run();
    removeStage(store, id, 'ship');
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the ship stage is not failed'));
  });

  it('refuses a ship stage that has a block', async () => {
    run();
    failedShip();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked', runAt: ENDED, gates: [] });
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the ship stage has a block'));
  });

  it('refuses when no ship step failed, because Retry ship would have nothing to run', async () => {
    run({ steps: [['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('no failed ship step to retry'));
  });

  it('refuses a newest run with no failed step of its own', async () => {
    run({ steps: [['pr', 'failed', 'gh: HTTP 502 Bad Gateway']] });
    run({ repo: 'other', steps: [['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the failed ship was not a GitHub server error'));
  });

  it('refuses when there is no ship run, or the newest run did not fail', async () => {
    // No run at all: Retry ship has no failed step to re-run.
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('no failed ship step to retry'));
    // A failed step of an older run still gives Retry ship a repo, but the NEWEST run passed.
    run({ steps: [['pr', 'failed', 'gh: HTTP 502 Bad Gateway']] });
    run({ repo: 'other', status: 'passed', steps: [['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual(none('the newest ship run did not fail'));
  });

  it('never retries without an attended run at or before the newest failed run', async () => {
    run({ unattended: true });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('no person confirmed a ship'));
  });

  it('retries after an unattended run that follows a person\'s confirm', async () => {
    run({ status: 'passed', unattended: false, endedAt: '2026-11-25T11:00:00.000Z' });
    run({ unattended: true });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('retry');
  });

  it('retries only when every failed step is a push or pr step with a GitHub server error', async () => {
    // No failed step at all: `failed.length > 0`.
    run({ steps: [['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('no failed ship step to retry'));
    // A failed commit step is not a push/pr step.
    store.db.prepare('DELETE FROM ship_operation_intents').run();
    store.db.prepare('DELETE FROM ship_repo_steps').run();
    store.db.prepare('DELETE FROM ship_runs').run();
    run({ steps: [['commit', 'failed', 'gh: HTTP 502']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the failed ship was not a GitHub server error'));
    // A push failure beside a pr server error is not only server errors (`every`, not `some`).
    store.db.prepare('DELETE FROM ship_operation_intents').run();
    store.db.prepare('DELETE FROM ship_repo_steps').run();
    store.db.prepare('DELETE FROM ship_runs').run();
    run({ steps: [['pr', 'failed', 'gh: HTTP 502'], ['push', 'failed', 'remote: HTTP 401 Bad credentials']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the failed ship was not a GitHub server error'));
    // A non-server detail on a push step.
    store.db.prepare('DELETE FROM ship_operation_intents').run();
    store.db.prepare('DELETE FROM ship_repo_steps').run();
    store.db.prepare('DELETE FROM ship_runs').run();
    run({ steps: [['push', 'failed', 'No commits between develop and karst/x']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the failed ship was not a GitHub server error'));
  });

  it('never retries when a worktree is dirty, unreadable, or the HEAD is not the pushed head', async () => {
    run();
    failedShip();
    const at = NOW + 10 * MIN;
    expect(await shipRetryDecision(store, id, at, seams({ worktreeClean: async () => ({ ok: true, clean: false }) }))).toEqual(none('the worktree of r has uncommitted changes'));
    expect(await shipRetryDecision(store, id, at, seams({ worktreeClean: async () => ({ ok: false }) }))).toEqual(none('the worktree of r cannot be read'));
    expect(await shipRetryDecision(store, id, at, seams({ localHead: async () => 'b'.repeat(40) }))).toEqual(none('the head of r is not the head the ship pushed'));
    expect(await shipRetryDecision(store, id, at, seams({ localHead: async () => null }))).toEqual(none('the head of r is not the head the ship pushed'));
  });

  it('never retries an unreadable head when the ship recorded no push intent', async () => {
    run({ head: null });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams({ localHead: async () => null })))
      .toEqual(none('the head of r is not the head the ship pushed'));
  });

  it('never rides along a repo whose latest failure is another kind', async () => {
    // An older run left repo 'old' failing on a bad credential; the newest run failed only on a server error for 'r'.
    run({ repo: 'old', steps: [['pr', 'failed', 'remote: HTTP 401 Bad credentials']], endedAt: '2026-11-25T11:00:00.000Z' });
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams()))
      .toEqual(none('a repo the ship would re-run failed on another error'));
  });

  it('reads the repos planRetryShip names and retries each one', async () => {
    run({ steps: [['push', 'failed', 'HTTP 503 Service Unavailable'], ['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('backs off 2/5/10/20/30 minutes and parks on the sixth consecutive server-error run', async () => {
    expect(AUTO_SHIP_RETRY_DELAYS_MS).toEqual([2, 5, 10, 20, 30].map((m) => m * MIN));
    for (const [i, delay] of AUTO_SHIP_RETRY_DELAYS_MS.entries()) {
      run();
      failedShip();
      const until = NOW + delay;
      expect(await shipRetryDecision(store, id, until - 1, seams())).toEqual({ kind: 'wait', until });
      expect(await shipRetryDecision(store, id, until, seams())).toEqual({ kind: 'retry', repos: ['r'], n: i + 1 });
    }
    const sixth = run();
    failedShip();
    const parked = seams();
    expect(await shipRetryDecision(store, id, NOW, parked)).toEqual({ kind: 'park', reason: AUTO_SHIP_RETRY_STOP_REASON, runId: sixth });
    expect(parked.worktreeClean).not.toHaveBeenCalled();
    expect(parked.localHead).not.toHaveBeenCalled();
    expect(AUTO_SHIP_RETRY_STOP_REASON).toBe('auto-fix stopped: GitHub server error, ship retried 5/5');
  });

  it('resets the count when a passed run or another failure sits in between', async () => {
    run();
    run();
    run({ status: 'passed', endedAt: '2026-11-25T11:30:00.000Z' });
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
    run({ steps: [['pr', 'failed', 'HTTP 401 Bad credentials']] });
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('never retries a run with no end time or an unreadable one', async () => {
    run();
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('retry');
    store.db.prepare('UPDATE ship_runs SET ended_at = NULL').run();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the newest failed ship run has no end time'));
    store.db.prepare("UPDATE ship_runs SET ended_at = 'not-a-time'").run();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual(none('the newest failed ship run has an unreadable end time'));
  });
});
