import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { acquireGateSlot, defaultGateSlotsDir, gatePoolName, leaseHeld } from './gateSlot.mjs';

const dirs = [];
const mkDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'karst-gslot-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('defaultGateSlotsDir', () => {
  it('is a fixed path under the home directory, not tmpdir', () => {
    expect(defaultGateSlotsDir({})).toBe(join(homedir(), '.karst', 'gate-slots'));
  });
  it('honours KARST_GATE_SLOTS_DIR', () => {
    expect(defaultGateSlotsDir({ KARST_GATE_SLOTS_DIR: '/x/y' })).toBe('/x/y');
  });
});

describe('gatePoolName', () => {
  it('matches the TypeScript encoding', () => {
    expect(gatePoolName('test:unit')).toBe('test%3Aunit');
    expect(gatePoolName('..')).toBe('%2E%2E');
  });
});

describe('leaseHeld', () => {
  it('is true only for "1"', () => {
    expect(leaseHeld({ KARST_GATE_LEASE_HELD: '1' })).toBe(true);
    expect(leaseHeld({})).toBe(false);
    expect(leaseHeld({ KARST_GATE_LEASE_HELD: '0' })).toBe(false);
  });
});

describe('acquireGateSlot', () => {
  it('claims slot-0 and releases it', async () => {
    const dir = mkDir();
    const lease = await acquireGateSlot('visual', { dir, pollMs: 5 });
    expect(readdirSync(join(dir, 'visual'))).toEqual(['slot-0']);
    lease.release();
    expect(readdirSync(join(dir, 'visual'))).toEqual([]);
  });

  it('waits while a live holder owns the slot, and names the holder pid', async () => {
    const dir = mkDir();
    const first = await acquireGateSlot('visual', { dir, pollMs: 5 });
    const lines = [];
    let got = false;
    const second = acquireGateSlot('visual', { dir, pollMs: 5, onWait: (h) => lines.push(h) }).then((l) => {
      got = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toBe(false);
    expect(lines).toEqual([{ pid: process.pid, ticket: null }]);
    first.release();
    (await second).release();
    expect(got).toBe(true);
  });

  it('reclaims the stale lease of a killed holder', async () => {
    const dir = mkDir();
    const slot = join(dir, 'visual', 'slot-0');
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, 'owner'), '999999');
    const lease = await acquireGateSlot('visual', { dir, pollMs: 5, alive: () => false });
    expect(existsSync(join(slot, 'owner'))).toBe(true);
    lease.release();
  });

  it('rejects when aborted while waiting', async () => {
    const dir = mkDir();
    const first = await acquireGateSlot('visual', { dir, pollMs: 5 });
    const abort = new AbortController();
    const waiting = acquireGateSlot('visual', { dir, pollMs: 5, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    await expect(waiting).rejects.toThrow(/aborted/);
    first.release();
  });
});
