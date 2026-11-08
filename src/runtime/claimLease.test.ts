import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseClaimSlot } from './claimLease.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'karst-claim-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('leaseClaimSlot', () => {
  it('claims the lowest free slot and frees it on release', async () => {
    const dir = tmp();
    const a = await leaseClaimSlot({ dir, slots: 2 });
    const b = await leaseClaimSlot({ dir, slots: 2 });
    expect([a.slot, b.slot]).toEqual([0, 1]);
    await a.release();
    await a.release(); // idempotent
    expect(readdirSync(dir)).toEqual(['slot-1']);
    await b.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('makes the second claim wait with maxConcurrent 1 until the first releases', async () => {
    const dir = tmp();
    const first = await leaseClaimSlot({ dir, slots: 1, pollMs: 5 });
    const waits: number[] = [];
    let got = false;
    const second = leaseClaimSlot({ dir, slots: 1, pollMs: 5, onWait: (held) => waits.push(held) }).then((l) => {
      got = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toBe(false);
    expect(waits).toEqual([1]); // reported once, not on every poll
    await first.release();
    const lease = await second;
    expect(got).toBe(true);
    await lease.release();
  });

  it('reclaims a slot whose owner pid is dead', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'owner'), '999999');
    const lease = await leaseClaimSlot({ dir, slots: 1, pollMs: 5, isAlive: () => false });
    expect(lease.slot).toBe(0);
    await lease.release();
  });

  it('does not reclaim a slot whose owner is alive', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'owner'), '1');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(leaseClaimSlot({ dir, slots: 1, pollMs: 5, isAlive: () => true, signal: ac.signal })).rejects.toThrow(
      /aborted/,
    );
  });

  it('rejects when the signal aborts during the wait', async () => {
    const dir = tmp();
    await leaseClaimSlot({ dir, slots: 1 });
    const ac = new AbortController();
    const waiting = leaseClaimSlot({ dir, slots: 1, pollMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(waiting).rejects.toThrow(/aborted/);
  });

  it('rejects a slot count below 1', async () => {
    await expect(leaseClaimSlot({ dir: tmp(), slots: 0 })).rejects.toThrow(/slots/);
  });
});
