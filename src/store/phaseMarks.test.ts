import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setStage } from './stages.js';
import { recordPhaseMark, listPhaseMarks } from './phaseMarks.js';
import { openImplementationRun } from './implementationRuns.js';
import { openImplementationSegment } from './implementationRuns.js';
import { recordSessionLaunchIntent } from './sessionLaunchIntents.js';

describe('reported phase marks', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const mark = (
    ticketId: number,
    phaseName: string,
    markedAt: string,
    attempt = 0,
    stageKey: 'impl' | 'fix' = 'impl',
  ) => recordPhaseMark(store, { ticketId, stageKey, attempt, phaseName, markedAt });

  it('returns marks oldest first, in the order they were reported', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'research', '2026-07-20T12:00:00.000Z');
    mark(t.id, 'plan', '2026-07-20T12:05:00.000Z');
    mark(t.id, 'implement', '2026-07-20T12:20:00.000Z');

    const marks = listPhaseMarks(store, t.id);
    expect(marks.map((m) => m.phaseName)).toEqual(['research', 'plan', 'implement']);
    expect(marks.map((m) => m.markedAt)).toEqual([
      '2026-07-20T12:00:00.000Z',
      '2026-07-20T12:05:00.000Z',
      '2026-07-20T12:20:00.000Z',
    ]);
    expect(marks.every((m) => m.stageKey === 'impl')).toBe(true);
  });

  it('reports marks in the order they arrived even when the timestamps disagree', () => {
    // Insertion order IS report order (§5): `id` is the record of what karst was
    // told and when it was told. A clock-skewed or agent-supplied `markedAt` must
    // not be able to reorder the history after the fact.
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'research', '2026-07-20T12:30:00.000Z');
    mark(t.id, 'plan', '2026-07-20T12:00:00.000Z');

    expect(listPhaseMarks(store, t.id).map((m) => m.phaseName)).toEqual(['research', 'plan']);
  });

  it('keeps both rows when the same phase is fired twice', () => {
    // §5: approaches legitimately loop (research → plan → research). Deduping at
    // write time would destroy the evidence that the loop happened; whether the
    // UI renders the phase once is the model layer's decision, not the store's.
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'research', '2026-07-20T12:00:00.000Z');
    mark(t.id, 'plan', '2026-07-20T12:05:00.000Z');
    mark(t.id, 'research', '2026-07-20T12:40:00.000Z');

    const marks = listPhaseMarks(store, t.id);
    expect(marks).toHaveLength(3);
    expect(marks.map((m) => m.phaseName)).toEqual(['research', 'plan', 'research']);
    expect(marks.map((m) => m.markedAt)).toEqual([
      '2026-07-20T12:00:00.000Z',
      '2026-07-20T12:05:00.000Z',
      '2026-07-20T12:40:00.000Z',
    ]);
    expect(new Set(marks.map((m) => m.id)).size).toBe(3);
  });

  it('stores a phase name the approach never declared, verbatim', () => {
    // §5: rejecting an undeclared name would silently drop the single most
    // interesting signal — that the agent went off-script.
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'improvise', '2026-07-20T12:00:00.000Z');

    expect(listPhaseMarks(store, t.id)[0]!.phaseName).toBe('improvise');
  });

  it('round-trips the attempt each mark landed under', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'implement', '2026-07-20T12:00:00.000Z', 0);
    mark(t.id, 'implement', '2026-07-20T13:00:00.000Z', 2);

    expect(listPhaseMarks(store, t.id).map((m) => m.attempt)).toEqual([0, 2]);
  });

  it('round-trips the stage a mark was reported against', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'implement', '2026-07-20T12:00:00.000Z', 0, 'impl');
    mark(t.id, 'implement', '2026-07-20T13:00:00.000Z', 1, 'fix');

    expect(listPhaseMarks(store, t.id).map((m) => m.stageKey)).toEqual(['impl', 'fix']);
  });

  it('scopes reads to one ticket', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    mark(a.id, 'research', '2026-07-20T12:00:00.000Z');
    mark(b.id, 'implement', '2026-07-20T12:00:00.000Z');

    const forA = listPhaseMarks(store, a.id);
    const forB = listPhaseMarks(store, b.id);
    expect(forA.map((m) => m.phaseName)).toEqual(['research']);
    expect(forB.map((m) => m.phaseName)).toEqual(['implement']);
    expect(forA.every((m) => m.ticketId === a.id)).toBe(true);
    expect(forB.every((m) => m.ticketId === b.id)).toBe(true);
  });

  it('survives the stage row being overwritten by a retry', () => {
    // `stages` is keyed (ticket_id, stage_key), so a retry overwrites in place.
    // This table is the only place the phases of the earlier attempt survive.
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'research', '2026-07-20T12:00:00.000Z');
    setStage(store, t.id, 'impl', { status: 'passed', verdict: null });

    expect(listPhaseMarks(store, t.id).map((m) => m.phaseName)).toEqual(['research']);
  });

  it('returns nothing for a ticket that reported no phases', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    expect(listPhaseMarks(store, t.id)).toEqual([]);
  });

  it('legacy marks keep null implementation-run and segment linkage', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    mark(t.id, 'research', '2026-07-20T12:00:00.000Z');
    const m = listPhaseMarks(store, t.id)[0]!;
    expect(m.implementationRunId).toBeNull();
    expect(m.implementationSegmentId).toBeNull();
  });

  it('attributes a mark to the ticket’s open implementation run, resolved in the writer', () => {
    // Nothing names the run at the call site: the writer stamps the ticket's
    // currently-open implementation_runs row, like `attempt` and `markedAt` —
    // server-side facts a mark can never forge from argv.
    const t = createTicket(store, { key: 'A', title: 'a' });
    const run = openImplementationRun(store, {
      ticketId: t.id, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-07-20T12:00:00.000Z',
    });
    mark(t.id, 'research', '2026-07-20T12:00:00.000Z');
    expect(listPhaseMarks(store, t.id)[0]!.implementationRunId).toBe(run.id);
  });

  it('keeps a mark made outside any open run unattributed, not an error', () => {
    // A mark fired with no open run is a real state: NULL is the truthful
    // answer, and the timeline filter must keep it out of every run's view.
    const t = createTicket(store, { key: 'A', title: 'a' });
    openImplementationRun(store, {
      ticketId: t.id, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-07-20T12:00:00.000Z',
    });
    store.db.prepare('UPDATE implementation_runs SET ended_at = ? WHERE ticket_id = ?').run(
      '2026-07-20T12:30:00.000Z',
      t.id,
    );
    mark(t.id, 'research', '2026-07-20T12:40:00.000Z');
    expect(listPhaseMarks(store, t.id)[0]!.implementationRunId).toBeNull();
  });

  it('round-trips segment linkage when the caller names a run and segment', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    // Real FK targets: the linkage is enforced, never guessed.
    const run = openImplementationRun(store, {
      ticketId: t.id, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-07-20T12:00:00.000Z',
    });
    const intent = recordSessionLaunchIntent(store, {
      ticketId: t.id, launchId: 'l1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-07-20T12:00:00.000Z',
    });
    const segment = openImplementationSegment(store, {
      implementationRunId: run.id, provider: 'claude', model: 'opus',
      launchIntentId: intent.id, startedAt: '2026-07-20T12:00:00.000Z',
    });
    recordPhaseMark(store, {
      ticketId: t.id, stageKey: 'impl', attempt: 0, phaseName: 'implement',
      markedAt: '2026-07-20T12:00:00.000Z',
      implementationRunId: run.id, implementationSegmentId: segment.id,
    });
    const m = listPhaseMarks(store, t.id)[0]!;
    expect(m.implementationRunId).toBe(run.id);
    expect(m.implementationSegmentId).toBe(segment.id);
  });
});
