import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { openProcessRun } from './processRuns.js';
import {
  recordUatFindings,
  listUatFindings,
  listUatFindingsByProcess,
} from './uatFindings.js';

/**
 * `uat_findings` (v31) — the UAT Tester process's structured observations.
 * Evidence/observations ONLY, never a verdict source: the ordinary UAT gates
 * stay authoritative and the deterministic `uat.testerVerifier` boundary is
 * the sole Tester-specific verdict.
 */
describe('uat_findings', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  const openTesterRun = () =>
    openProcessRun(store, {
      ticketId,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      startedAt: '2026-08-08T10:00:00.000Z',
    });

  it('records a batch and lists it back with ids, in report order', () => {
    const run = openTesterRun();
    const ids = recordUatFindings(store, {
      ticketId,
      processRunId: run.id,
      createdAt: '2026-08-08T10:05:00.000Z',
      findings: [
        { severity: 'critical', repo: '/web', title: 'explodes' },
        { severity: 'low', title: 'nit', file: 'src/a.ts', line: 12 },
      ],
    });
    expect(ids).toHaveLength(2);
    const rows = listUatFindings(store, ticketId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: ids[0],
      ticketId,
      processRunId: run.id,
      severity: 'critical',
      repo: '/web',
      title: 'explodes',
      filePath: null,
      line: null,
      createdAt: '2026-08-08T10:05:00.000Z',
    });
    expect(rows[1]).toMatchObject({
      severity: 'low',
      repo: null,
      filePath: 'src/a.ts',
      line: 12,
    });
  });

  it("lists only one process run's observations", () => {
    const runA = openTesterRun();
    const runB = openTesterRun();
    recordUatFindings(store, {
      ticketId,
      processRunId: runA.id,
      createdAt: 'x',
      findings: [{ severity: 'info', title: 'a' }],
    });
    recordUatFindings(store, {
      ticketId,
      processRunId: runB.id,
      createdAt: 'x',
      findings: [{ severity: 'info', title: 'b' }],
    });
    expect(listUatFindingsByProcess(store, runA.id).map((f) => f.title)).toEqual(['a']);
    expect(listUatFindingsByProcess(store, runB.id).map((f) => f.title)).toEqual(['b']);
  });

  it('drops an empty batch without writing anything', () => {
    expect(
      recordUatFindings(store, {
        ticketId,
        processRunId: openTesterRun().id,
        createdAt: 'x',
        findings: [],
      }),
    ).toEqual([]);
    expect(listUatFindings(store, ticketId)).toEqual([]);
  });

  it('degrades an unrecognized severity to info at the read boundary', () => {
    const run = openTesterRun();
    recordUatFindings(store, {
      ticketId,
      processRunId: run.id,
      createdAt: 'x',
      findings: [{ severity: 'critical', title: 'boom' }],
    });
    store.db
      .prepare('UPDATE uat_findings SET severity = ? WHERE ticket_id = ?')
      .run('CRITICAL', ticketId);
    expect(listUatFindings(store, ticketId)[0]!.severity).toBe('info');
  });

  it('cascades away with its process run (ON DELETE CASCADE)', () => {
    const run = openTesterRun();
    recordUatFindings(store, {
      ticketId,
      processRunId: run.id,
      createdAt: 'x',
      findings: [{ severity: 'info', title: 'x' }],
    });
    store.db.prepare('DELETE FROM process_runs WHERE id = ?').run(run.id);
    expect(listUatFindings(store, ticketId)).toEqual([]);
  });
});
