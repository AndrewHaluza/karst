import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editsDir, readEditOps, withdrawEditOp, writeEditOp } from './editOps.js';
import { MAX_SETUP_PROPOSAL_BYTES } from './proposal.js';

let outbox: string;
beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), 'edit-ops-'));
});
afterEach(() => rmSync(outbox, { recursive: true, force: true }));

const ids = (): (() => string) => {
  let n = 0;
  return () => `id-${(n += 1)}`;
};

describe('edit ops', () => {
  it('reads no op from an outbox without an edits directory', () => {
    expect(readEditOps(outbox)).toEqual([]);
  });

  it('keeps the call order, also when the clock stands still or runs back', () => {
    const uuid = ids();
    const times = [1000, 1000, 500];
    for (const t of times) writeEditOp(outbox, 'set-general', { host: 'h' }, { uuid, now: () => t });
    expect(readEditOps(outbox).map((o) => o.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('never gives one seq to two calls: a claimed seq is skipped', () => {
    mkdirSync(editsDir(outbox), { recursive: true });
    writeFileSync(join(editsDir(outbox), '.seq-000000000001000'), '');
    const op = writeEditOp(outbox, 'set-general', { host: 'h' }, { uuid: () => 'a1', now: () => 1000 });
    expect(op.seq).toBe('000000000001001');
    expect(readdirSync(editsDir(outbox)).filter((n) => n.startsWith('.seq-'))).toEqual(['.seq-000000000001000']);
  });

  it('writes the tool and the input into the op', () => {
    writeEditOp(outbox, 'set-general', { host: 'h' }, { uuid: () => 'a1', now: () => 7 });
    expect(readEditOps(outbox)).toEqual([{ id: 'a1', seq: '000000000000007', tool: 'set-general', input: { host: 'h' } }]);
  });

  it('refuses an oversize op and leaves no file', () => {
    const big = { x: 'y'.repeat(MAX_SETUP_PROPOSAL_BYTES) };
    expect(() => writeEditOp(outbox, 'set-general', big)).toThrow(/too large/);
    expect(readEditOps(outbox)).toEqual([]);
  });

  it('skips a malformed or hostile file', () => {
    mkdirSync(editsDir(outbox));
    writeFileSync(join(editsDir(outbox), '0-x.json'), '{not json');
    writeFileSync(join(editsDir(outbox), '1-y.json'), JSON.stringify({ id: '../up', seq: '1', tool: 't', input: {} }));
    writeFileSync(join(editsDir(outbox), '2-z.json'), JSON.stringify({ id: 'z', seq: '2', tool: 't', input: [] }));
    expect(readEditOps(outbox)).toEqual([]);
  });

  it('withdraws only the exact id, not an id that ends the same', () => {
    writeEditOp(outbox, 'set-git', {}, { uuid: () => 'a-1', now: () => 1 });
    expect(withdrawEditOp(outbox, '1')).toEqual({ ok: false, error: "no pending edit '1'" });
    expect(readEditOps(outbox)).toHaveLength(1);
  });

  it('withdraws one op and refuses an unknown or invalid id', () => {
    const uuid = ids();
    writeEditOp(outbox, 'set-git', {}, { uuid, now: () => 1 });
    writeEditOp(outbox, 'set-git', {}, { uuid, now: () => 2 });
    expect(withdrawEditOp(outbox, 'id-1')).toEqual({ ok: true });
    expect(readEditOps(outbox).map((o) => o.id)).toEqual(['id-2']);
    expect(withdrawEditOp(outbox, 'id-1')).toEqual({ ok: false, error: "no pending edit 'id-1'" });
    expect(withdrawEditOp(outbox, '../x')).toEqual({ ok: false, error: "invalid edit id '../x'" });
    expect(readdirSync(editsDir(outbox))).toHaveLength(1);
  });
});
