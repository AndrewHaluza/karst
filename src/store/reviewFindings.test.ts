import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { setStage } from './stages.js';
import { openProcessRun } from './processRuns.js';
import {
  recordFindings,
  listFindings,
  latestFindingBatch,
  type FindingInput,
} from './reviewFindings.js';

describe('review findings evidence', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const finding = (overrides: Partial<FindingInput> = {}): FindingInput => ({
    severity: 'high',
    repo: '/web',
    file: 'src/app.ts',
    line: 12,
    title: 'unhandled rejection',
    detail: 'a promise rejection is never caught',
    source: 'agent',
    ...overrides,
  });

  it('appends one row per finding, preserving the order they were given', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [
        finding({ title: 'first' }),
        finding({ title: 'second' }),
        finding({ title: 'third' }),
      ],
    });

    const rows = listFindings(store, t.id);
    expect(rows.map((r) => r.title)).toEqual(['first', 'second', 'third']);
    expect(rows.every((r) => r.attempt === 0)).toBe(true);
    expect(rows.every((r) => r.runAt === '2026-08-01T12:00:00.000Z')).toBe(true);
  });

  it('records nothing when a run reports no findings', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [],
    });
    expect(listFindings(store, t.id)).toEqual([]);
  });

  it('keeps both invocations when two runs share one attempt', () => {
    // Mirrors gate_runs: `transition` only bumps `attempt` on the failed
    // branch, so a fail->fix->pass cycle files two invocations under one
    // attempt. A natural (ticket, attempt) key would collide here.
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 1,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ title: 'first pass' })],
    });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 1,
      runAt: '2026-08-01T12:30:00.000Z',
      findings: [finding({ title: 'second pass' })],
    });

    const rows = listFindings(store, t.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title)).toEqual(['first pass', 'second pass']);
  });

  it('commits a whole batch atomically — a single bad row lands nothing', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const findings: FindingInput[] = [
      finding({ title: 'good row' }),
      // Force a NOT NULL violation on the second row, bypassing the type
      // system the way corrupted caller input would.
      finding({ title: null as unknown as string }),
    ];

    expect(() =>
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T12:00:00.000Z',
        findings,
      }),
    ).toThrow();

    // Nothing landed — not even the row that would have been valid alone.
    expect(listFindings(store, t.id)).toEqual([]);
  });

  it('round-trips the process run that produced a batch', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const run = openProcessRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      processId: 'review',
      attempt: 0,
      startedAt: '2026-08-01T11:59:00.000Z',
    });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      processRunId: run.id,
      findings: [finding({ title: 'linked' })],
    });

    const row = listFindings(store, t.id)[0]!;
    expect(row.processRunId).toBe(run.id);
  });

  it('records a NULL process run for a batch whose caller named none', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ title: 'unlinked' })],
    });

    expect(listFindings(store, t.id)[0]!.processRunId).toBeNull();
  });

  it('survives the stage row being overwritten by a retry', () => {
    // `stages` is keyed (ticket_id, stage_key), so a retry overwrites the
    // verdict in place. This table is the only place prior findings survive.
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ title: 'kept' })],
    });
    setStage(store, t.id, 'review', { status: 'failed', verdict: 'fix' });
    setStage(store, t.id, 'review', { status: 'passed', verdict: null });

    expect(listFindings(store, t.id).map((r) => r.title)).toEqual(['kept']);
  });

  it('scopes reads to one ticket', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    recordFindings(store, {
      ticketId: a.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ title: 'a-finding' })],
    });
    recordFindings(store, {
      ticketId: b.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ title: 'b-finding' })],
    });

    expect(listFindings(store, a.id).map((r) => r.title)).toEqual(['a-finding']);
    expect(listFindings(store, b.id).map((r) => r.title)).toEqual(['b-finding']);
  });

  it('round-trips file/line as null when a finding is not file-scoped', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T12:00:00.000Z',
      findings: [finding({ file: null, line: null, repo: '' })],
    });

    const row = listFindings(store, t.id)[0]!;
    expect(row.file).toBeNull();
    expect(row.line).toBeNull();
    expect(row.repo).toBe('');
  });

  describe('latestFindingBatch', () => {
    it('picks the greatest run_at, never the last-inserted row', () => {
      // Insert the NEWER batch first and the OLDER batch second — if the
      // reduction picked by array/insertion position instead of run_at, it
      // would return the older, second-inserted batch.
      const t = createTicket(store, { key: 'A', title: 'a' });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 1,
        runAt: '2026-08-01T13:00:00.000Z',
        findings: [finding({ title: 'newer' })],
      });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T12:00:00.000Z',
        findings: [finding({ title: 'older' })],
      });

      const latest = latestFindingBatch(store, t.id);
      expect(latest.map((r) => r.title)).toEqual(['newer']);
    });

    it('returns every finding of the latest batch, not just one', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T12:00:00.000Z',
        findings: [finding({ title: 'stale-1' })],
      });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 1,
        runAt: '2026-08-01T13:00:00.000Z',
        findings: [finding({ title: 'current-1' }), finding({ title: 'current-2' })],
      });

      const latest = latestFindingBatch(store, t.id);
      expect(latest.map((r) => r.title).sort()).toEqual(['current-1', 'current-2']);
    });

    it('returns an empty array for a ticket with no recorded findings', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      expect(latestFindingBatch(store, t.id)).toEqual([]);
    });
  });

  describe('reading corrupted rows', () => {
    /** Insert a row directly, bypassing recordFindings, to simulate corruption. */
    function insertRaw(
      store: Store,
      ticketId: number,
      overrides: { severity?: string; source?: string },
    ): void {
      store.db
        .prepare(
          `INSERT INTO review_findings
             (ticket_id, attempt, run_at, severity, repo, file, line, title, detail, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticketId,
          0,
          '2026-08-01T12:00:00.000Z',
          overrides.severity ?? 'high',
          '/web',
          null,
          null,
          'title',
          'detail',
          overrides.source ?? 'agent',
          '2026-08-01T12:00:00.000Z',
        );
    }

    it('degrades an unrecognized severity to info rather than throwing', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      insertRaw(store, t.id, { severity: 'urgent' });

      expect(() => listFindings(store, t.id)).not.toThrow();
      expect(listFindings(store, t.id)[0]!.severity).toBe('info');
    });

    it('degrades an unrecognized source to agent rather than throwing', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      insertRaw(store, t.id, { source: 'robot-overlord' });

      expect(() => listFindings(store, t.id)).not.toThrow();
      expect(listFindings(store, t.id)[0]!.source).toBe('agent');
    });

    it('keeps every recognized severity distinct', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
        insertRaw(store, t.id, { severity });
      }
      expect(listFindings(store, t.id).map((r) => r.severity)).toEqual([
        'critical',
        'high',
        'medium',
        'low',
        'info',
      ]);
    });
  });

  // `stages` is keyed (ticket_id, stage_key) and a retry OVERWRITES it, so this
  // table is the only place a prior review attempt's findings survive. That
  // property holds only while nothing can rewrite or remove a row — a single
  // UPDATE or DELETE reaching `review_findings` would silently turn evidence
  // into current state.
  //
  // Intercepted at `prepare`, the way `diagnostics/collectMetadata.test.ts`
  // asserts its registry reads are read-only: every statement the module
  // actually issues is inspected, so an UPDATE assembled by interpolation or
  // reached through a helper is caught just the same. A source scan would see
  // only literal SQL in this one file.
  it('never UPDATEs or DELETEs — the table is append-only evidence', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const originalPrepare = store.db.prepare.bind(store.db);
    const statements: string[] = [];
    const recordingStore = {
      ...store,
      db: new Proxy(store.db, {
        get(target, property, receiver) {
          if (property !== 'prepare') return Reflect.get(target, property, receiver);
          return (sql: string) => {
            statements.push(sql);
            return originalPrepare(sql);
          };
        },
      }),
    } as Store;

    recordFindings(recordingStore, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-02T10:00:00Z',
      findings: [finding(), finding({ severity: 'low' })],
    });
    listFindings(recordingStore, t.id);
    latestFindingBatch(recordingStore, t.id);

    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => /\b(UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
  });
});
