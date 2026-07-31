import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { runStageDriver, type StageDriverDeps } from './driver.js';
import { createTicketFlow } from './stages/create.js';

function seedAtUat(store: Store): number {
  const t = createTicket(store, { key: 'K-1', title: 'demo' });
  transition(store, t.id, 'scope', { kind: 'passed' }); // -> impl
  transition(store, t.id, 'impl', { kind: 'passed' });  // -> uat (marker)
  return t.id;
}

function baseDeps(store: Store, over: Partial<StageDriverDeps> = {}): StageDriverDeps {
  return {
    store,
    worktreeFor: () => '/wt',
    onProgress: () => {},
    shouldContinue: () => true,
    // -> review / -> ship: adapt the still-StageKey-returning transition into
    // StageRunResult minimally; the real runners return it themselves once they
    // are rewritten in a later task.
    runUat: async (id) => ({ kind: 'advanced', next: transition(store, id, 'uat', { kind: 'passed' }) }),
    runReview: async (id) => ({ kind: 'advanced', next: transition(store, id, 'review', { kind: 'passed' }) }),
    ...over,
  };
}

describe('runStageDriver', () => {
  it('auto-chains uat->review then stops at ship for confirm', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const out = await runStageDriver(baseDeps(store), id);
    expect(out).toEqual({ stage: 'ship', status: 'blocked', reason: 'ship-confirm' });
    store.close();
  });

  it('stops at fix when a gate fails', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const deps = baseDeps(store, {
      runUat: async (i) => ({
        kind: 'advanced',
        next: transition(store, i, 'uat', { kind: 'failed', reason: 'exit 1' }), // -> fix
      }),
    });
    const out = await runStageDriver(deps, id);
    expect(out).toEqual({ stage: 'fix', status: 'blocked', reason: 'gate-failed' });
    store.close();
  });

  it('halts at the boundary when shouldContinue is false', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const out = await runStageDriver(baseDeps(store, { shouldContinue: () => false }), id);
    expect(out.status).toBe('stopped');
    expect(out.stage).toBe('uat');
    store.close();
  });

  it('throws when the worktree is missing', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    await expect(runStageDriver(baseDeps(store, { worktreeFor: () => null }), id)).rejects.toThrow(/worktree/);
    store.close();
  });

  it('halts at a blocked stage without looping or transitioning', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-3', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });

    let uatRuns = 0;
    const outcome = await runStageDriver(
      {
        store,
        worktreeFor: () => '/wt',
        onProgress: () => {},
        shouldContinue: () => true,
        runUat: async () => {
          uatRuns += 1;
          return { kind: 'blocked', blocker: 'nothing-to-run', reason: 'no scripts' };
        },
        runReview: async () => ({ kind: 'advanced', next: 'ship' }),
      },
      id,
    );

    expect(uatRuns).toBe(1);
    expect(outcome).toEqual({ stage: 'uat', status: 'blocked', reason: 'nothing-to-run: no scripts' });
    store.close();
  });

  it('halts when a runner reports it was stopped mid-stage', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-4', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });

    const outcome = await runStageDriver(
      {
        store,
        worktreeFor: () => '/wt',
        onProgress: () => {},
        shouldContinue: () => true,
        runUat: async () => ({ kind: 'stopped' }),
        runReview: async () => ({ kind: 'advanced', next: 'ship' }),
      },
      id,
    );

    expect(outcome).toEqual({ stage: 'uat', status: 'stopped' });
    store.close();
  });
});
