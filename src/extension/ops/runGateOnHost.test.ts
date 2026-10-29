import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { createTicket } from '../../store/tickets.js';
import { getHostGates } from '../../store/ticketGates.js';
import { runKilledGatesOnHost } from './runGateOnHost.js';

function seed(rows: Array<{ gateName: string; exitCode: number | null; repo?: string | null; skipped?: boolean }>, stageKey = 'uat') {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'K-1', title: 't', source: 'manual' }).id;
  recordGateRun(store, {
    ticketId: id, stageKey: stageKey as 'uat', attempt: 1, runAt: '2026-10-29T10:00:00.000Z',
    gates: rows.map((r) => ({ gateName: r.gateName, exitCode: r.exitCode, repo: r.repo ?? null, skipped: r.skipped ?? false })),
  } as never);
  return { store, id };
}

describe('runKilledGatesOnHost', () => {
  it('records only the SIGKILLed gates, by bare name', () => {
    const { store, id } = seed([
      { gateName: 'unit (web)', exitCode: 137, repo: 'web' },
      { gateName: 'lint', exitCode: 1 },
      { gateName: 'types', exitCode: 0 },
    ]);
    expect(runKilledGatesOnHost(store, id, 'uat')).toEqual(['unit']);
    expect(getHostGates(store, id)).toEqual(['unit']);
  });

  it('records nothing when no gate was killed or the stage differs', () => {
    const { store, id } = seed([{ gateName: 'unit', exitCode: 137 }], 'review');
    expect(runKilledGatesOnHost(store, id, 'uat')).toEqual([]);
    expect(getHostGates(store, id)).toEqual([]);
  });

  it('merges with names already recorded, without duplicates', () => {
    const { store, id } = seed([{ gateName: 'unit', exitCode: 137 }]);
    runKilledGatesOnHost(store, id, 'uat');
    runKilledGatesOnHost(store, id, 'uat');
    expect(getHostGates(store, id)).toEqual(['unit']);
  });
});
