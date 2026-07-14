import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { runStageDriver, type StageDriverDeps } from './driver.js';

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
    runUat: async (id) => transition(store, id, 'uat', { kind: 'passed' }),      // -> review
    runReview: async (id) => transition(store, id, 'review', { kind: 'passed' }), // -> ship
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
      runUat: async (i) => transition(store, i, 'uat', { kind: 'failed', reason: 'exit 1' }), // -> fix
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
});
