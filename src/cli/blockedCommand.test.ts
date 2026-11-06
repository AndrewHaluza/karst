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
    expect(text).toContain('review-stalled 1 now / 1 in the 14 days before');
  });

  it('counts blocks per kind now and in the 14 days before, and filters by kind', () => {
    stall('K-1', '2026-11-05T12:00:00.000Z');
    stall('K-2', '2026-10-30T12:00:00.000Z');
    stall('K-3', '2026-09-01T12:00:00.000Z'); // older than 14 days: now only
    const t = createTicket(store, { key: 'K-4', title: 'x' });
    setStage(store, t.id, 'ship', { blockedKind: 'awaiting-merge', blockedReason: 'w', blockedAt: '2026-11-04T00:00:00.000Z' });
    const report = collectBlocked(store, scope);
    expect(report.summary).toEqual([
      { kind: 'review-stalled', now: 3, before: 2 },
      { kind: 'awaiting-merge', now: 1, before: 1 },
    ]);
    const only = JSON.parse(runBlockedCommand(store, { json: true, kind: 'awaiting-merge' }, scope));
    expect(only.rows.map((r: { key: string }) => r.key)).toEqual(['K-4']);
    expect(only.summary).toHaveLength(1);
  });

  it('skips archived and done tickets from the rows', () => {
    const id = stall('K-1', '2026-11-05T12:00:00.000Z');
    store.db.prepare("UPDATE tickets SET archived_at = '2026-11-05' WHERE id = ?").run(id);
    const report = collectBlocked(store, scope);
    expect(report.rows).toEqual([]);
    expect(report.summary).toEqual([{ kind: 'review-stalled', now: 0, before: 1 }]);
  });

  it('scopes to one project when given', () => {
    const id = stall('K-1', '2026-11-05T12:00:00.000Z');
    store.db.prepare('UPDATE tickets SET project_id = 7 WHERE id = ?').run(id);
    stall('K-2', '2026-11-05T12:00:00.000Z');
    expect(collectBlocked(store, { ...scope, projectId: 7 }).rows.map((r) => r.key)).toEqual(['K-1']);
  });
});
