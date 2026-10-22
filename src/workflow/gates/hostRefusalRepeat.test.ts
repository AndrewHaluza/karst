import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { openGateRun } from './evidence.js';
import { escalatedRefusalReason, hostRefusalRepeats } from './hostRefusalRepeat.js';

const DIRTY = 'host gates not run: the host worktree has uncommitted changes: `?? x`';

describe('host refusal repeat detection', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  });

  /** One uat run recording the given rows; returns its run id. */
  const run = (rows: { exitCode: number | null; summary: string | null }[]): number => {
    const ev = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt: new Date().toISOString() });
    ev.append(rows.map((r, i) => ({ gateName: `g${i}`, ...r })));
    return ev.runId;
  };

  it('is false for the first refusal', () => {
    expect(hostRefusalRepeats(store, id, 'uat', run([{ exitCode: null, summary: DIRTY }]))).toBe(false);
  });

  it('is true when the previous run was refused with the same reason', () => {
    run([{ exitCode: null, summary: DIRTY }]);
    expect(hostRefusalRepeats(store, id, 'uat', run([{ exitCode: null, summary: DIRTY }]))).toBe(true);
  });

  it('is false when the reason differs', () => {
    run([{ exitCode: null, summary: DIRTY }]);
    expect(hostRefusalRepeats(store, id, 'uat', run([{ exitCode: null, summary: 'host gates not run: HEAD differs' }]))).toBe(false);
  });

  it('is false when a clean run (gates ran) came in between', () => {
    run([{ exitCode: null, summary: DIRTY }]);
    run([{ exitCode: 0, summary: null }]);
    expect(hostRefusalRepeats(store, id, 'uat', run([{ exitCode: null, summary: DIRTY }]))).toBe(false);
  });

  it('names the manual action, for dirty files with the worktree', () => {
    expect(escalatedRefusalReason(DIRTY, true, '/w')).toContain('remove or commit these files in /w');
    expect(escalatedRefusalReason('sandbox sync failed', true, '/w')).toContain('repeats');
    expect(escalatedRefusalReason(DIRTY, false, '/w')).toBe(DIRTY);
  });
});
