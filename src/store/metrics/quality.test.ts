import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createTicket } from '../tickets.js';
import {
  findingDensity,
  findingSourceSplit,
  gateKillDistribution,
  interruptions,
  reworkLoops,
} from './quality.js';

describe('quality metrics', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const processRun = (ticketId: number, status = 'passed'): number => {
    const info = store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'impl', 'p', 0, ?, '2026-07-20T00:00:00.000Z')`,
      )
      .run(ticketId, status);
    return Number(info.lastInsertRowid);
  };

  it('splits gate runs into failed, passed, skipped and absent-script', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const gate = (name: string, exitCode: number | null, skipped = 0): void => {
      store.db
        .prepare(
          `INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, skipped)
           VALUES (?, 'review', 0, '2026-07-20T00:00:00.000Z', ?, ?, ?)`,
        )
        .run(t.id, name, exitCode, skipped);
    };
    gate('lint', 0);
    gate('test', 1);
    gate('test', 2);
    gate('typecheck', null);
    gate('e2e', null, 1);

    const result = gateKillDistribution(store, {});
    expect(result.runs).toBe(5);
    expect(result.failed).toBe(2);
    expect(result.byGate).toEqual([
      { gateName: 'e2e', runs: 1, passed: 0, failed: 0, skipped: 1, noScript: 0 },
      { gateName: 'lint', runs: 1, passed: 1, failed: 0, skipped: 0, noScript: 0 },
      { gateName: 'test', runs: 2, passed: 0, failed: 2, skipped: 0, noScript: 0 },
      { gateName: 'typecheck', runs: 1, passed: 0, failed: 0, skipped: 0, noScript: 1 },
    ]);
    // A NULL exit code is "no such script" — never folded into the pass count.
    expect(result.passed).toBe(1);
    expect(result.byExitCode).toEqual([
      { exitCode: 1, count: 1 },
      { exitCode: 2, count: 1 },
    ]);
  });

  it('summarises recovery rounds, including exhausted episodes', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const round = (
      episode: number,
      roundNumber: number,
      status: string,
      triggerKind = 'uat-findings',
    ): void => {
      store.db
        .prepare(
          `INSERT INTO recovery_rounds
             (ticket_id, source_stage, source_process_id, trigger_kind, trigger_detail,
              episode, round, max_rounds, status, started_at, interrupt_count)
           VALUES (?, 'uat', 'p', ?, '', ?, ?, 3, ?, '2026-07-20T00:00:00.000Z', 1)`,
        )
        .run(t.id, triggerKind, episode, roundNumber, status);
    };
    round(1, 1, 'passed');
    round(2, 1, 'failed');
    round(2, 2, 'exhausted', 'review-findings');

    const result = reworkLoops(store, {});
    expect(result).toMatchObject({ rounds: 3, episodes: 2, exhaustedEpisodes: 1, maxRoundReached: 2 });
    expect(result.meanRoundsPerEpisode).toBeCloseTo(1.5);
    expect(result.byStatus).toEqual([
      { status: 'exhausted', count: 1 },
      { status: 'failed', count: 1 },
      { status: 'passed', count: 1 },
    ]);
    expect(result.byTriggerKind).toEqual([
      { triggerKind: 'review-findings', count: 1 },
      { triggerKind: 'uat-findings', count: 2 },
    ]);
  });

  it('counts review and UAT findings by severity, separately', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const run = processRun(t.id);
    store.db
      .prepare(
        `INSERT INTO review_findings
           (ticket_id, attempt, run_at, severity, repo, title, detail, source, created_at)
         VALUES (?, 0, '2026-07-20T00:00:00.000Z', ?, 'one', 't', 'd', ?, '2026-07-20T00:00:00.000Z')`,
      )
      .run(t.id, 'high', 'agent');
    store.db
      .prepare(
        `INSERT INTO uat_findings (ticket_id, process_run_id, severity, title, created_at)
         VALUES (?, ?, 'low', 't', '2026-07-20T00:00:00.000Z')`,
      )
      .run(t.id, run);

    const result = findingDensity(store, {});
    expect(result.review).toEqual({ total: 1, bySeverity: [{ severity: 'high', count: 1 }] });
    expect(result.uat).toEqual({ total: 1, bySeverity: [{ severity: 'low', count: 1 }] });
    expect(result.perMergedTicket).toBeNull();
  });

  it('reports the agent-vs-human split of review findings', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const finding = (source: string): void => {
      store.db
        .prepare(
          `INSERT INTO review_findings
             (ticket_id, attempt, run_at, severity, repo, title, detail, source, created_at)
           VALUES (?, 0, '2026-07-20T00:00:00.000Z', 'high', 'one', 't', 'd', ?, '2026-07-20T00:00:00.000Z')`,
        )
        .run(t.id, source);
    };
    finding('agent');
    finding('agent');
    finding('human');

    const result = findingSourceSplit(store, {});
    expect(result).toMatchObject({ agent: 2, human: 1, total: 3 });
    expect(result.humanShare).toBeCloseTo(1 / 3);
  });

  it('counts interrupted process runs and recovery interrupts', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    processRun(t.id, 'interrupted');
    processRun(t.id, 'passed');
    store.db
      .prepare(
        `INSERT INTO recovery_rounds
           (ticket_id, source_stage, source_process_id, trigger_kind, trigger_detail,
            episode, round, max_rounds, status, started_at, interrupt_count)
         VALUES (?, 'uat', 'p', 'k', '', 1, 1, 3, 'passed', '2026-07-20T00:00:00.000Z', 4)`,
      )
      .run(t.id);

    const result = interruptions(store, {});
    expect(result).toMatchObject({ processRuns: 2, interruptedProcessRuns: 1, recoveryInterrupts: 4 });
    expect(result.interruptRate).toBeCloseTo(0.5);
  });
});
