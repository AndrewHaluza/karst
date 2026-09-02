import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, getTicket } from './tickets.js';
import { setStage } from './stages.js';
import { transition } from '../workflow/machine.js';
import { autoArchiveDoneTickets } from './doneArchive.js';

const NOW = '2026-08-10T00:00:00.000Z';
/** 3 days before NOW — the cutoff every test that expects an archive uses. */
const OLD = '2026-08-01T00:00:00.000Z';

function driveToDone(store: Store, id: number): void {
  for (const stage of ['scope', 'impl', 'uat', 'review', 'ship'] as const) {
    transition(store, id, stage, { kind: 'passed' });
  }
}

describe('autoArchiveDoneTickets', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('archives a done ticket whose delay has elapsed', () => {
    const t = createTicket(store, { key: 'A-1', title: 'done long ago' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', { startedAt: OLD, endedAt: OLD });

    const archived = autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) });
    expect(archived).toEqual([t.id]);
    expect(getTicket(store, t.id).archivedAt).not.toBeNull();
  });

  it('leaves a ticket that reached done within the delay visible', () => {
    const t = createTicket(store, { key: 'B-1', title: 'done today' });
    driveToDone(store, t.id);

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
    expect(getTicket(store, t.id).archivedAt).toBeNull();
  });

  it('archives at exactly the cutoff (inclusive)', () => {
    const t = createTicket(store, { key: 'C-1', title: 'boundary' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', {
      startedAt: '2026-08-07T00:00:00.000Z',
      endedAt: '2026-08-07T00:00:00.000Z',
    });

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([
      t.id,
    ]);
  });

  it('skips a ticket that left done before the sweep ran', () => {
    const t = createTicket(store, { key: 'D-1', title: 'no longer done' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', { startedAt: OLD, endedAt: OLD });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
  });

  it('skips a ticket a human archived before the sweep — and never un-archives', () => {
    const t = createTicket(store, { key: 'E-1', title: 'archived by hand' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', { startedAt: OLD, endedAt: OLD });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(t.id);

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
    expect(getTicket(store, t.id).archivedAt).not.toBeNull();
  });

  it('is idempotent — a second run archives nothing', () => {
    const t = createTicket(store, { key: 'F-1', title: 'twice' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', { startedAt: OLD, endedAt: OLD });

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([
      t.id,
    ]);
    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
  });

  it('skips a done row that never actually passed (recovered current, pending row)', () => {
    const t = createTicket(store, { key: 'G-1', title: 'never finished' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
  });

  it('skips a done row with no end time — the clock is unknown, not elapsed', () => {
    const t = createTicket(store, { key: 'H-1', title: 'no clock' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'done', { status: 'passed', endedAt: null });

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
  });

  it('a re-entered done stage restarts the delay — the done row was overwritten', () => {
    const t = createTicket(store, { key: 'I-1', title: 'redone' });
    driveToDone(store, t.id);
    setStage(store, t.id, 'done', { startedAt: OLD, endedAt: OLD });
    // The machine overwrites `ended_at` when the ticket re-enters done, so the
    // sweep must read a FRESH clock and hold off again.
    setStage(store, t.id, 'done', {
      startedAt: '2026-08-09T00:00:00.000Z',
      endedAt: '2026-08-09T00:00:00.000Z',
    });

    expect(autoArchiveDoneTickets(store, { afterDays: 3, now: new Date(NOW) })).toEqual([]);
  });

  it('archives only within the scoped project — another window\'s board is untouched', () => {
    store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
    store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(2, 'other');
    const mine = createTicket(store, { key: 'P-1', title: 'mine', projectId: 1 });
    const theirs = createTicket(store, { key: 'Q-1', title: 'other window', projectId: 2 });
    for (const id of [mine.id, theirs.id]) {
      driveToDone(store, id);
      setStage(store, id, 'done', { startedAt: OLD, endedAt: OLD });
    }

    expect(
      autoArchiveDoneTickets(store, {
        afterDays: 3,
        now: new Date(NOW),
        scope: { projectId: 1 },
      }),
    ).toEqual([mine.id]);
    expect(getTicket(store, theirs.id).archivedAt).toBeNull();
  });
});
