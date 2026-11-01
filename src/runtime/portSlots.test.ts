import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EPHEMERAL_FLOOR,
  PORT_OFFSET_ENV,
  PORT_SLOT_COUNT,
  PORT_SLOT_STRIDE,
  leasePortSlot,
  readPortOffset,
  shiftBand,
} from './portSlots.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'karst-slots-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readPortOffset', () => {
  it('defaults to 0 when unset or empty', () => {
    expect(readPortOffset({})).toBe(0);
    expect(readPortOffset({ [PORT_OFFSET_ENV]: '' })).toBe(0);
  });
  it('parses a valid offset', () => {
    expect(readPortOffset({ [PORT_OFFSET_ENV]: '2000' })).toBe(2000);
  });
  it.each(['abc', '-1', '1.5', '999999'])('rejects %s', (v) => {
    expect(() => readPortOffset({ [PORT_OFFSET_ENV]: v })).toThrow(PORT_OFFSET_ENV);
  });
});

describe('shiftBand', () => {
  it('is the identity at offset 0', () => {
    expect(shiftBand(28600, 29000, 0)).toEqual({ from: 28600, ceiling: 29000 });
  });
  it('keeps every suite band below the ephemeral range for every slot', () => {
    const bands: Array<[number, number]> = [[28000, 28100], [28100, 28200], [28200, 28600], [28600, 29000]];
    for (let slot = 0; slot < PORT_SLOT_COUNT; slot++) {
      for (const [from, ceiling] of bands) {
        const b = shiftBand(from, ceiling, slot * PORT_SLOT_STRIDE);
        expect(b.from).toBe(from + slot * PORT_SLOT_STRIDE);
        expect(b.ceiling).toBeLessThanOrEqual(EPHEMERAL_FLOOR);
      }
    }
  });
  it('refuses an offset that crosses the ephemeral floor', () => {
    expect(() => shiftBand(28600, 29000, PORT_SLOT_COUNT * PORT_SLOT_STRIDE)).toThrow(/ephemeral/);
  });
});

describe('leasePortSlot', () => {
  it('hands out distinct slots and reuses a released one', async () => {
    const dir = tmp();
    const a = await leasePortSlot({ dir });
    const b = await leasePortSlot({ dir });
    expect(a.offset).not.toBe(b.offset);
    await a.release();
    const c = await leasePortSlot({ dir });
    expect(c.offset).toBe(a.offset);
  });

  it('release is idempotent and removes the claim', async () => {
    const dir = tmp();
    const a = await leasePortSlot({ dir });
    await a.release();
    await a.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reclaims a slot whose owner died (kill/OOM)', async () => {
    const dir = tmp();
    for (let s = 0; s < PORT_SLOT_COUNT; s++) {
      mkdirSync(join(dir, `slot-${s}`));
      writeFileSync(join(dir, `slot-${s}`, 'owner'), '99999999');
    }
    const got = await leasePortSlot({ dir, isAlive: () => false });
    expect(got.offset).toBe(0);
    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
  });

  it('waits and logs when all slots are held, then takes a freed one', async () => {
    const dir = tmp();
    const held = [];
    for (let s = 0; s < PORT_SLOT_COUNT; s++) held.push(await leasePortSlot({ dir }));
    const logs: string[] = [];
    const pending = leasePortSlot({ dir, pollMs: 5, onDebug: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 30));
    await held[1]!.release();
    const got = await pending;
    expect(got.offset).toBe(PORT_SLOT_STRIDE);
    expect(logs.some((m) => /waiting/.test(m))).toBe(true);
  });

  it('rejects when aborted while waiting', async () => {
    const dir = tmp();
    for (let s = 0; s < PORT_SLOT_COUNT; s++) await leasePortSlot({ dir });
    const ac = new AbortController();
    const pending = leasePortSlot({ dir, pollMs: 5, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe('leasePortSlot stale-reclaim race', () => {
  it('two concurrent reclaimers of one dead slot never both win it', async () => {
    const dir = tmp();
    for (let s = 0; s < PORT_SLOT_COUNT; s++) {
      mkdirSync(join(dir, `slot-${s}`));
      writeFileSync(join(dir, `slot-${s}`, 'owner'), '99999999');
    }
    const live = new Set<number>();
    const isAlive = (pid: number): boolean => pid === process.pid && live.size > 0;
    live.add(1);
    // All four are dead except none: reclaim with 4 concurrent leasers → 4 distinct slots.
    const got = await Promise.all(Array.from({ length: PORT_SLOT_COUNT }, () => leasePortSlot({ dir, pollMs: 5, isAlive })));
    expect(new Set(got.map((g) => g.slot)).size).toBe(PORT_SLOT_COUNT);
  });
});
