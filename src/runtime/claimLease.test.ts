import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

  const TEN_MIN_AGO = (): Date => new Date(Date.now() - 10 * 60_000);

  it('writes owner, token and heartbeat on claim', async () => {
    const dir = tmp();
    const lease = await leaseClaimSlot({ dir, slots: 1 });
    expect(readdirSync(join(dir, 'slot-0')).sort()).toEqual(['heartbeat', 'owner', 'token']);
    await lease.release();
  });

  it('reclaims a live owner whose heartbeat is older than the stale age', async () => {
    const dir = tmp();
    const claim = join(dir, 'slot-0');
    mkdirSync(claim);
    writeFileSync(join(claim, 'owner'), String(process.pid));
    writeFileSync(join(claim, 'token'), 'other');
    writeFileSync(join(claim, 'heartbeat'), '');
    utimesSync(join(claim, 'heartbeat'), TEN_MIN_AGO(), TEN_MIN_AGO());
    const lease = await leaseClaimSlot({ dir, slots: 1, pollMs: 5, heartbeatMs: 20 });
    expect(lease.slot).toBe(0);
    expect(readFileSync(join(claim, 'token'), 'utf8')).not.toBe('other');
    await lease.release();
  });

  it('does not reclaim a live owner whose heartbeat looks stale but is refreshed within one period', async () => {
    const dir = tmp();
    const claim = join(dir, 'slot-0');
    mkdirSync(claim);
    writeFileSync(join(claim, 'owner'), String(process.pid));
    writeFileSync(join(claim, 'token'), 'other');
    const hb = join(claim, 'heartbeat');
    writeFileSync(hb, '');
    utimesSync(hb, TEN_MIN_AGO(), TEN_MIN_AGO());
    const ctl = new AbortController();
    // The holder wakes from sleep and beats again while the waiter is still polling.
    const beat = setInterval(() => utimesSync(hb, new Date(), new Date()), 10);
    const waiter = leaseClaimSlot({ dir, slots: 1, pollMs: 5, heartbeatMs: 200, signal: ctl.signal });
    const outcome = await Promise.race([waiter.then(() => 'claimed'), new Promise((r) => setTimeout(() => r('waiting'), 400))]);
    clearInterval(beat);
    ctl.abort();
    await waiter.catch(() => undefined);
    expect(outcome).toBe('waiting');
    expect(readFileSync(join(claim, 'token'), 'utf8')).toBe('other');
  });

  it('keeps a live owner with no heartbeat file', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'owner'), String(process.pid));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await expect(leaseClaimSlot({ dir, slots: 1, pollMs: 5, signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(readFileSync(join(dir, 'slot-0', 'owner'), 'utf8')).toBe(String(process.pid));
  });

  it('keeps a live owner with a fresh heartbeat', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'owner'), String(process.pid));
    writeFileSync(join(dir, 'slot-0', 'heartbeat'), '');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await expect(leaseClaimSlot({ dir, slots: 1, pollMs: 5, signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(readFileSync(join(dir, 'slot-0', 'owner'), 'utf8')).toBe(String(process.pid));
  });

  it('release does not delete a claim that another lease took over', async () => {
    const dir = tmp();
    const lease = await leaseClaimSlot({ dir, slots: 1 });
    writeFileSync(join(dir, 'slot-0', 'token'), 'other');
    await lease.release();
    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
  });

  it('the heartbeat refreshes the mtime', async () => {
    const dir = tmp();
    const lease = await leaseClaimSlot({ dir, slots: 1, heartbeatMs: 20 });
    const hb = join(dir, 'slot-0', 'heartbeat');
    utimesSync(hb, TEN_MIN_AGO(), TEN_MIN_AGO());
    await new Promise((r) => setTimeout(r, 80));
    expect(Math.abs(Date.now() - statSync(hb).mtimeMs)).toBeLessThan(5_000);
    await lease.release();
  });
});
