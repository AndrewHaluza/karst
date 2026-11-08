import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import { listArchCitations, upsertArchCitation } from './archCitations.js';

describe('arch citations store', () => {
  it('stores one row per ticket and key, ordered by key', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'P-1', title: 't', source: 'manual' });
    upsertArchCitation(store, t.id, { key: '@arch:UATHOST-00', reason: 'one' });
    upsertArchCitation(store, t.id, { key: '@arch:CLI-02', reason: 'two' });
    expect(listArchCitations(store, t.id).map((c) => c.key)).toEqual(['@arch:CLI-02', '@arch:UATHOST-00']);
  });

  it('replaces the reason when a key is cited again', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'P-1', title: 't', source: 'manual' });
    expect(upsertArchCitation(store, t.id, { key: '@arch:CLI-02', reason: 'old' })).toEqual({ replaced: false });
    expect(upsertArchCitation(store, t.id, { key: '@arch:CLI-02', reason: 'new' })).toEqual({ replaced: true });
    expect(listArchCitations(store, t.id)).toEqual([{ key: '@arch:CLI-02', reason: 'new' }]);
  });

  it('keeps tickets apart', () => {
    const store = openStore(':memory:');
    const a = createTicket(store, { key: 'P-1', title: 'a', source: 'manual' });
    const b = createTicket(store, { key: 'P-2', title: 'b', source: 'manual' });
    upsertArchCitation(store, a.id, { key: '@arch:CLI-02', reason: 'x' });
    expect(listArchCitations(store, b.id)).toEqual([]);
  });
});
