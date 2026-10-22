import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import { doneMergedTicketIds, isDoneMerged } from './doneMerged.js';

function seed() {
  const store = openStore(':memory:');
  const mk = (key: string, stage: string | null) => {
    const t = createTicket(store, { key, title: key });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
    return t.id;
  };
  const pr = (id: number, n: number, merged: string | null, dismissed: string | null = null) =>
    store.db.prepare('INSERT INTO prs (ticket_id, repo, number, merged_at, dismissed_at) VALUES (?, ?, ?, ?, ?)').run(id, 'r', n, merged, dismissed);
  return { store, mk, pr };
}

describe('doneMergedTicketIds', () => {
  it('needs done + at least one PR + every undismissed PR merged', () => {
    const { store, mk, pr } = seed();
    const merged = mk('A', 'done'); pr(merged, 1, '2026-01-01');
    const open = mk('B', 'done'); pr(open, 2, '2026-01-01'); pr(open, 3, null);
    const dismissed = mk('C', 'done'); pr(dismissed, 4, '2026-01-01'); pr(dismissed, 5, null, '2026-01-02');
    const noPr = mk('D', 'done');
    const notDone = mk('E', 'ship'); pr(notDone, 6, '2026-01-01');
    expect([...doneMergedTicketIds(store)].sort()).toEqual([merged, dismissed].sort());
    expect(isDoneMerged(store, noPr)).toBe(false);
    expect(isDoneMerged(store, open)).toBe(false);
    expect(isDoneMerged(store, notDone)).toBe(false);
  });
});
