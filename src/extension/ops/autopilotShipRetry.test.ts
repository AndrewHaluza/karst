import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import { transition } from '../../workflow/machine.js';
import {
  beginShipOperationPreparation, closeShipRun, finishShipRepoStep, openShipRepoStep, openShipRun,
  type ShipStep,
} from '../../store/shipRuns.js';
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

/** The ship stage reads failed with no block (a failed ship after the person's confirm). */
function failedShip(endedAt = ENDED): void {
  setStage(store, id, 'ship', { status: 'failed', verdict: 'ship failed', endedAt });
}

interface RunOpts {
  readonly status?: 'failed' | 'passed';
  readonly unattended?: boolean;
  readonly endedAt?: string;
  readonly steps?: ReadonlyArray<readonly [ShipStep, 'passed' | 'failed' | 'note', string]>;
  /** `null`: record no push intent for the run. */
  readonly head?: string | null;
}

function run(opts: RunOpts = {}): number {
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
  closeShipRun(store, r.id, (opts.status ?? 'failed') === 'passed' ? 'passed' : 'failed', endedAt);
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
    const until = NOW + AUTO_SHIP_RETRY_DELAYS_MS[0]!;
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual({ kind: 'wait', until });
    expect(await shipRetryDecision(store, id, until - 1, seams())).toEqual({ kind: 'wait', until });
    expect(await shipRetryDecision(store, id, until, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('does not retry a ship that is not failed, is running, or has a block', async () => {
    run();
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none');
    setStage(store, id, 'ship', { status: 'running' });
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none');
    failedShip();
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'blocked', runAt: ENDED, gates: [] });
    expect((await shipRetryDecision(store, id, NOW, seams())).kind).toBe('none');
  });

  it('never retries without an attended run at or before the newest failed run', async () => {
    run({ unattended: true });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual({ kind: 'none', why: 'no person confirmed a ship' });
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
    expect((await shipRetryDecision(store, id, at, { ...seams(), worktreeClean: async () => { throw new Error('boom'); } })).kind).toBe('none');
  });

  it('never retries a repo whose ship recorded no push intent', async () => {
    run({ head: null });
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
  });

  it('reads the repos planRetryShip names and retries each one', async () => {
    run({ steps: [['push', 'failed', 'HTTP 503 Service Unavailable'], ['pr', 'passed', 'ok']] });
    failedShip();
    expect(await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).toEqual({ kind: 'retry', repos: ['r'], n: 1 });
  });

  it('backs off 2/5/10/20/30 minutes and parks after the fifth retry', async () => {
    expect(AUTO_SHIP_RETRY_DELAYS_MS).toEqual([2, 5, 10, 20, 30].map((m) => m * MIN));
    for (const [i, delay] of AUTO_SHIP_RETRY_DELAYS_MS.entries()) {
      run();
      failedShip();
      const until = NOW + delay;
      expect(await shipRetryDecision(store, id, until - 1, seams())).toEqual({ kind: 'wait', until });
      expect(await shipRetryDecision(store, id, until, seams())).toEqual({ kind: 'retry', repos: ['r'], n: i + 1 });
    }
    // The sixth consecutive server-error run spends the bound: no sixth retry.
    run();
    failedShip();
    expect(await shipRetryDecision(store, id, NOW, seams())).toEqual({ kind: 'park', reason: AUTO_SHIP_RETRY_STOP_REASON });
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

  it('never retries a run that has no end time', async () => {
    run();
    failedShip();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('retry');
    store.db.prepare('UPDATE ship_runs SET ended_at = NULL').run();
    expect((await shipRetryDecision(store, id, NOW + 10 * MIN, seams())).kind).toBe('none');
  });
});
