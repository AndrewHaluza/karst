import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, withdrawProposal, writeProposalResult, resultsDir } from './ledger.js';

let outbox: string;
beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), 'ledger-'));
});
afterEach(() => rmSync(outbox, { recursive: true, force: true }));

const result = (id: string, status: 'applied' | 'declined' = 'applied') => ({
  id, kind: 'manifest' as const, status, dropped: ['gates'], sha256: 'abc', at: '2026-01-01T00:00:00.000Z',
});

describe('ledger', () => {
  it('lists pending files with their kind, and host results', () => {
    writeFileSync(join(outbox, 'p1.json'), JSON.stringify({ kind: 'change' }));
    writeFileSync(join(outbox, 'p2.json'), 'garbage');
    writeProposalResult(outbox, result('r1'));
    const byId = Object.fromEntries(readLedger(outbox).map((r) => [r.id, r]));
    expect(byId.p1).toMatchObject({ status: 'pending', kind: 'change' });
    expect(byId.p2).toMatchObject({ status: 'pending', kind: 'unknown' });
    expect(byId.r1).toMatchObject({ status: 'applied', dropped: ['gates'], sha256: 'abc' });
  });

  it('a result wins over a leftover pending file; malformed results are ignored', () => {
    writeFileSync(join(outbox, 'r1.json'), '{}');
    writeProposalResult(outbox, result('r1', 'declined'));
    writeFileSync(join(resultsDir(outbox), 'bad.json'), JSON.stringify({ status: 'bogus' }));
    const ledger = readLedger(outbox);
    expect(ledger.map((r) => [r.id, r.status])).toEqual([['r1', 'declined']]);
  });

  it('withdraw removes a pending proposal and the ledger shows it withdrawn', () => {
    writeFileSync(join(outbox, 'p1.json'), '{}');
    expect(withdrawProposal(outbox, 'p1')).toEqual({ ok: true });
    expect(existsSync(join(outbox, 'p1.json'))).toBe(false);
    expect(readLedger(outbox)).toMatchObject([{ id: 'p1', status: 'withdrawn' }]);
  });

  it('withdraw refuses unknown ids and path traversal', () => {
    expect(withdrawProposal(outbox, 'nope')).toMatchObject({ ok: false });
    mkdirSync(join(outbox, 'x'));
    expect(withdrawProposal(outbox, '../x')).toMatchObject({ ok: false, error: expect.stringContaining('invalid') });
  });
});
