import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { recordFindings } from '../store/reviewFindings.js';
import { parseBlockedArgs, collectBlocked, runBlockedCommand } from './blockedCommand.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const scope = { now: () => NOW };

describe('karst blocked — parse', () => {
  it('defaults to text with no kind', () => {
    expect(parseBlockedArgs(['blocked'])).toEqual({ json: false });
  });
  it('accepts --kind and --json', () => {
    expect(parseBlockedArgs(['blocked', '--kind', 'review-stalled', '--json'])).toEqual({
      json: true,
      kind: 'review-stalled',
    });
  });
  it('rejects a wrong command, an unknown flag and a bad kind', () => {
    expect(() => parseBlockedArgs(['stats'])).toThrow(/blocked/);
    expect(() => parseBlockedArgs(['blocked', '--nope'])).toThrow(/unknown flag/);
    expect(() => parseBlockedArgs(['blocked', '--kind'])).toThrow(/--kind/);
    expect(() => parseBlockedArgs(['blocked', '--kind', 'x; drop'])).toThrow(/--kind/);
  });
});

describe('karst blocked — report', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function stall(key: string, blockedAt: string): number {
    const t = createTicket(store, { key, title: key });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'fix', {
      blockedKind: 'review-stalled',
      blockedReason: 'blocking findings hit src/a.ts for 2 rounds',
      blockedAt,
    });
    for (const [n, runAt] of [[1, '2026-11-05T10:00:00.000Z'], [2, '2026-11-05T11:00:00.000Z']] as const) {
      recordFindings(store, {
        ticketId: t.id,
        attempt: n,
        runAt,
        findings: [{ severity: 'high', repo: 'r', file: 'src/a.ts', line: 10 + n, title: 't', detail: 'd', source: 'agent' }],
      });
    }
    return t.id;
  }

  it('prints "no block" and an empty summary when nothing is blocked', () => {
    createTicket(store, { key: 'A', title: 'a' });
    const out = runBlockedCommand(store, { json: false }, scope);
    expect(out).toContain('No open ticket has a block.');
    expect(out).toContain('Blocks by kind: none');
    expect(JSON.parse(runBlockedCommand(store, { json: true }, scope))).toEqual({ rows: [], summary: [] });
  });

  it('lists a ticket at fix with a review-stalled block and its findings per round', () => {
    stall('K-1', '2026-11-05T12:00:00.000Z');
    const report = collectBlocked(store, scope);
    expect(report.rows).toEqual([
      {
        key: 'K-1',
        stage: 'fix',
        kind: 'review-stalled',
        since: '2026-11-05T12:00:00.000Z',
        reason: 'blocking findings hit src/a.ts for 2 rounds',
        agentState: 'none',
        rounds: [
          { attempt: 1, findings: ['src/a.ts:11'] },
          { attempt: 2, findings: ['src/a.ts:12'] },
        ],
      },
    ]);
    const text = runBlockedCommand(store, { json: false }, scope);
    expect(text).toContain('K-1  stage=fix  kind=review-stalled');
    expect(text).toContain('round 2: src/a.ts:12');
    expect(text).toContain('review-stalled 1 now / 0 in the 14 days before');
    expect(text).toContain('resolved blocks are not stored');
  });

  it('counts open blocks as now and only blocks on tickets no longer open as before', () => {
    stall('K-1', '2026-11-05T12:00:00.000Z');
    stall('K-2', '2026-10-30T12:00:00.000Z'); // open: in "now", never in "before"
    const gone = stall('K-3', '2026-11-01T12:00:00.000Z');
    store.db.prepare("UPDATE tickets SET stage_current = 'closed' WHERE id = ?").run(gone);
    const old = stall('K-5', '2026-09-01T12:00:00.000Z'); // older than 14 days: neither
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(old);
    const t = createTicket(store, { key: 'K-4', title: 'x' });
    setStage(store, t.id, 'ship', { blockedKind: 'awaiting-merge', blockedReason: 'w', blockedAt: '2026-11-04T00:00:00.000Z' });
    const report = collectBlocked(store, scope);
    expect(report.rows.map((r) => r.key).sort()).toEqual(['K-1', 'K-2', 'K-4']);
    expect(report.summary).toEqual([
      { kind: 'review-stalled', now: 2, before: 1 },
      { kind: 'awaiting-merge', now: 1, before: 0 },
    ]);
    const only = JSON.parse(runBlockedCommand(store, { json: true, kind: 'awaiting-merge' }, scope));
    expect(only.rows.map((r: { key: string }) => r.key)).toEqual(['K-4']);
    expect(only.summary).toHaveLength(1);
  });

  it('skips archived, done and closed tickets from the rows', () => {
    const a = stall('K-1', '2026-11-05T12:00:00.000Z');
    const d = stall('K-2', '2026-11-05T12:00:00.000Z');
    const c = stall('K-3', '2026-11-05T12:00:00.000Z');
    store.db.prepare("UPDATE tickets SET archived_at = '2026-11-05' WHERE id = ?").run(a);
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(d);
    store.db.prepare("UPDATE tickets SET stage_current = 'closed' WHERE id = ?").run(c);
    const report = collectBlocked(store, scope);
    expect(report.rows).toEqual([]);
    expect(report.summary).toEqual([{ kind: 'review-stalled', now: 0, before: 3 }]);
  });

  it('reads the findings with the configured floor', () => {
    const id = stall('K-1', '2026-11-05T12:00:00.000Z');
    recordFindings(store, {
      ticketId: id,
      attempt: 3,
      runAt: '2026-11-05T12:30:00.000Z',
      findings: [{ severity: 'medium', repo: 'r', file: 'src/m.ts', line: 1, title: 't', detail: 'd', source: 'agent' }],
    });
    const files = (floor?: 'medium' | 'none'): string[] =>
      (collectBlocked(store, { ...scope, ...(floor ? { stallFloor: floor } : {}) }).rows[0]!.rounds ?? []).flatMap((r) => [...r.findings]);
    expect(files()).not.toContain('src/m.ts:1');
    expect(files('medium')).toContain('src/m.ts:1');
    expect(files('none')).toEqual([]);
  });

  it('scopes to one project when given', () => {
    const id = stall('K-1', '2026-11-05T12:00:00.000Z');
    store.db.prepare('UPDATE tickets SET project_id = 7 WHERE id = ?').run(id);
    stall('K-2', '2026-11-05T12:00:00.000Z');
    expect(collectBlocked(store, { ...scope, projectId: 7 }).rows.map((r) => r.key)).toEqual(['K-1']);
  });

  it('lists a ticket parked at fix with its park verdict as a fix-parked block', () => {
    const t = createTicket(store, { key: 'K-9', title: 'parked' });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'fix', {
      status: 'failed',
      verdict: 'fix attempts exhausted',
      endedAt: '2026-11-05T09:00:00.000Z',
    });
    const live = createTicket(store, { key: 'K-10', title: 'fixing' });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(live.id);
    setStage(store, live.id, 'fix', { status: 'running' });
    const report = collectBlocked(store, scope);
    expect(report.rows).toEqual([
      {
        key: 'K-9',
        stage: 'fix',
        kind: 'fix-parked',
        since: '2026-11-05T09:00:00.000Z',
        reason: 'fix attempts exhausted',
        agentState: 'none',
      },
    ]);
    expect(report.summary).toEqual([{ kind: 'fix-parked', now: 1, before: 0 }]);
  });

  it('lists a fix park whose verdict is dynamic host text', () => {
    const t = createTicket(store, { key: 'K-7', title: 'rerun' });
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'fix', { status: 'failed', verdict: 'host re-run failed: typecheck exit 2', endedAt: '2026-11-05T09:00:00.000Z' });
    expect(collectBlocked(store, scope).rows.map((r) => [r.key, r.kind, r.reason])).toEqual([
      ['K-7', 'fix-parked', 'host re-run failed: typecheck exit 2'],
    ]);
  });

  it('counts a park on a ticket that is no longer open as fix-parked before', () => {
    const t = createTicket(store, { key: 'K-8', title: 'old park' });
    store.db.prepare("UPDATE tickets SET stage_current = 'closed' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'fix', { status: 'failed', verdict: 'fix attempts exhausted', endedAt: '2026-11-03T09:00:00.000Z' });
    expect(collectBlocked(store, scope).summary).toEqual([{ kind: 'fix-parked', now: 0, before: 1 }]);
  });

  describe('auto-deliver of a resolved merge', () => {
    const GATES = JSON.stringify(['lint', 'unit', 'visual']);
    function awaitingMerge(key: string): number {
      const t = createTicket(store, { key, title: key });
      setStage(store, t.id, 'ship', { blockedKind: 'awaiting-merge', blockedReason: 'the pull request has changes and is not merged yet', blockedAt: '2026-11-04T00:00:00.000Z' });
      return t.id;
    }
    function run(ticketId: number, state: string, currentGate: string | null, startedAt: string): void {
      store.db
        .prepare('INSERT INTO deliver_runs (ticket_id, gates, current_gate, state, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(ticketId, GATES, currentGate, state, startedAt);
    }

    it('adds one auto-deliver line and the JSON field for a running run', () => {
      const id = awaitingMerge('K-1');
      run(id, 'running', 'visual', '2026-11-04T18:09:36.000Z');
      const text = runBlockedCommand(store, { json: false }, scope).split('\n');
      expect(text).toContain('  auto-deliver: gate visual (3 of 3) since 2026-11-04T18:09:36.000Z');
      expect(text[0]).toContain('K-1  stage=ship  kind=awaiting-merge');
      expect(text[1]).toContain('reason: the pull request has changes');
      const json = JSON.parse(runBlockedCommand(store, { json: true }, scope));
      expect(json.rows[0].delivering).toEqual({ gate: 'visual', index: 3, total: 3, startedAt: '2026-11-04T18:09:36.000Z' });
    });

    it('uses the newest running run', () => {
      const id = awaitingMerge('K-1');
      run(id, 'running', 'lint', '2026-11-04T18:00:00.000Z');
      run(id, 'running', 'unit', '2026-11-04T18:05:00.000Z');
      expect(collectBlocked(store, scope).rows[0]!.delivering).toMatchObject({ gate: 'unit', index: 2 });
    });

    it.each(['passed', 'failed', 'stopped'])('adds nothing for a %s run', (state) => {
      const id = awaitingMerge('K-1');
      run(id, state, 'visual', '2026-11-04T18:09:36.000Z');
      expect('delivering' in collectBlocked(store, scope).rows[0]!).toBe(false);
      expect(runBlockedCommand(store, { json: false }, scope)).not.toContain('auto-deliver');
    });

    it('adds nothing for a ticket with no run, between gates, or an unknown gate', () => {
      const id = awaitingMerge('K-1');
      expect(collectBlocked(store, scope).rows[0]!.delivering).toBeUndefined();
      run(id, 'running', null, '2026-11-04T18:09:36.000Z');
      expect(collectBlocked(store, scope).rows[0]!.delivering).toBeUndefined();
      run(id, 'running', 'nope', '2026-11-04T18:10:00.000Z');
      expect(collectBlocked(store, scope).rows[0]!.delivering).toBeUndefined();
    });

    it('treats a missing deliver_runs table (an old db) as no delivery', () => {
      awaitingMerge('K-1');
      store.db.exec('DROP TABLE deliver_gate_results; DROP TABLE deliver_runs;');
      const rows = collectBlocked(store, scope).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.delivering).toBeUndefined();
    });
  });
});
