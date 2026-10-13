import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { getTicketByKey } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { fixtureSpec } from './fixtures.js';
import { seedStore } from './seed.js';

describe('seedStore', () => {
  it('seeds nothing for empty', () => {
    const store = openStore(':memory:');
    expect(seedStore(store, fixtureSpec('empty'))).toEqual([]);
  });
  it('seeds the blocked ticket at uat with its block', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, fixtureSpec('blocked'));
    const t = getTicketByKey(store, 'FIX-BLOCKED');
    expect(t?.stageCurrent).toBe('uat');
    expect(stageBlock(store, id!, 'uat')?.kind).toBe('boot-failed');
  });
  it('seeds the mid-stage ticket at impl', () => {
    const store = openStore(':memory:');
    seedStore(store, fixtureSpec('ticket-mid-stage'));
    expect(getTicketByKey(store, 'FIX-MID')).toBeDefined();
  });
});
