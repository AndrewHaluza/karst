import { describe, expect, it } from 'vitest';
import { reconcileOnStart } from '../recovery/reconcile.js';
import { openStore } from '../store/db.js';
import { getTicketByKey } from '../store/tickets.js';
// @ts-expect-error plain .mjs runner module, no types
import { buildFixture } from '../../scripts/eval/variants.mjs';
import { parseFixtureFile } from './fixtureFile.js';
import { seedStore } from './seed.js';

const task = { id: 'org/repo:pr-1', brief: 'fix it' };
const variant = { provider: 'claude', gates: [] };

describe('eval fake-core settled seed', () => {
  it('stays at ship after boot reconcile', () => {
    const store = openStore(':memory:');
    const spec = parseFixtureFile(buildFixture({ task, variant, settled: true }));
    seedStore(store, spec);
    reconcileOnStart(store, () => false);
    expect(getTicketByKey(store, 'EVAL-1')?.stageCurrent).toBe('ship');
  });
});
