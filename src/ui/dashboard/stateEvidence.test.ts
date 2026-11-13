import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { recordGateRun, HOST_RERUN_SOURCE } from '../../store/gateRuns.js';
import { readEvidence } from './stateEvidence.js';

describe('readEvidence host re-run rows', () => {
  it('leaves the host re-run rows out of the gate batches', () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    const base = { ticketId: id, stageKey: 'uat' as const, attempt: 1, runAt: '2026-01-01T00:00:00Z' };
    recordGateRun(store, { ...base, gates: [{ gateName: 'visual', exitCode: 1 }] });
    recordGateRun(store, { ...base, source: HOST_RERUN_SOURCE, gates: [{ gateName: 'visual', exitCode: 0 }] });
    const ev = readEvidence(store, id);
    expect(ev.gateRuns.map((g) => g.exitCode)).toEqual([1]);
  });
});
