import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifyRecords, writeVerifyRecord } from './record.js';
import type { VerifyRecord } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-rec-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (id: string, status: VerifyRecord['status'] = 'verified'): VerifyRecord => ({
  id, kind: 'change', status, steps: [{ id: 'P1', label: 'shape', status: 'ok', detail: 'd' }],
  changes: [{ id: 'x', kind: 'cleared' }], pinnedSha256: 'abc', at: '2026-01-01T00:00:00.000Z',
});

describe('verify record', () => {
  it('round-trips records, sorted by id', () => {
    writeVerifyRecord(dir, rec('b'));
    writeVerifyRecord(dir, rec('a', 'unverified'));
    expect(readVerifyRecords(dir)).toEqual([rec('a', 'unverified'), rec('b')]);
  });
  it('refuses an id that is not a plain name', () => {
    expect(() => writeVerifyRecord(dir, rec('../x'))).toThrow(/invalid proposal id/);
  });
  it('gives none for a missing or unset directory', () => {
    expect(readVerifyRecords(join(dir, 'nope'))).toEqual([]);
    expect(readVerifyRecords(undefined)).toEqual([]);
    expect(readVerifyRecords('')).toEqual([]);
  });
  it('skips malformed files, unknown statuses and non-json names', () => {
    writeFileSync(join(dir, 'bad.json'), 'garbage');
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ status: 'bogus', steps: [], changes: [] }));
    writeFileSync(join(dir, 'nosteps.json'), JSON.stringify({ status: 'verified' }));
    writeFileSync(join(dir, 'note.txt'), '{}');
    writeFileSync(join(dir, 'big.json'), ' '.repeat(300 * 1024));
    writeVerifyRecord(dir, rec('ok'));
    expect(readVerifyRecords(dir).map((r) => r.id)).toEqual(['ok']);
  });
  it('defaults the kind, sha and time of a sparse record', () => {
    writeFileSync(join(dir, 's.json'), JSON.stringify({ status: 'refused', steps: [], changes: [] }));
    expect(readVerifyRecords(dir)[0]).toMatchObject({ kind: 'manifest', pinnedSha256: null, at: '' });
  });
});
