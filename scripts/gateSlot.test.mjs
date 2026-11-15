import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  describe('heartbeat and token', () => {
    const TEN_MIN_S = 10 * 60;
    const back = (file) => {
      const old = new Date(Date.now() - TEN_MIN_S * 1000);
      utimesSync(file, old, old);
    };
    const abortAfter = (ms) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), ms);
      return abort.signal;
    };

    it('writes owner, token, heartbeat and ticket on claim', async () => {
      const dir = mkDir();
      const lease = await acquireGateSlot('visual', { dir, pollMs: 5, ticket: 'T1' });
      expect(readdirSync(join(dir, 'visual', 'slot-0')).sort()).toEqual(['heartbeat', 'owner', 'ticket', 'token']);
      lease.release();
    });

    it('reclaims a live owner whose heartbeat is older than the stale age', async () => {
      const dir = mkDir();
      const slot = join(dir, 'visual', 'slot-0');
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, 'owner'), String(process.pid));
      writeFileSync(join(slot, 'token'), 'other');
      writeFileSync(join(slot, 'heartbeat'), '');
      back(join(slot, 'heartbeat'));
      const lease = await acquireGateSlot('visual', { dir, pollMs: 5 });
      expect(lease.slot).toBe(0);
      expect(readFileSync(join(slot, 'token'), 'utf8')).not.toBe('other');
      lease.release();
    });

    it('keeps a live owner with no heartbeat file', async () => {
      const dir = mkDir();
      const slot = join(dir, 'visual', 'slot-0');
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, 'owner'), String(process.pid));
      await expect(acquireGateSlot('visual', { dir, pollMs: 5, signal: abortAfter(60) })).rejects.toThrow(/aborted/);
      expect(readFileSync(join(slot, 'owner'), 'utf8')).toBe(String(process.pid));
    });

    it('release does not delete a claim that another lease took over', async () => {
      const dir = mkDir();
      const lease = await acquireGateSlot('visual', { dir, pollMs: 5 });
      const slot = join(dir, 'visual', 'slot-0');
      writeFileSync(join(slot, 'token'), 'other');
      lease.release();
      expect(existsSync(slot)).toBe(true);
    });

    it('release does not throw when the claim folder is gone', async () => {
      const dir = mkDir();
      const lease = await acquireGateSlot('visual', { dir, pollMs: 5 });
      rmSync(join(dir, 'visual', 'slot-0'), { recursive: true, force: true });
      expect(() => lease.release()).not.toThrow();
    });

    it('the heartbeat refreshes the mtime', async () => {
      const dir = mkDir();
      const lease = await acquireGateSlot('visual', { dir, pollMs: 5, heartbeatMs: 20 });
      const beat = join(dir, 'visual', 'slot-0', 'heartbeat');
      back(beat);
      await new Promise((r) => setTimeout(r, 80));
      expect(Math.abs(Date.now() - statSync(beat).mtimeMs)).toBeLessThan(5_000);
      lease.release();
    });
  });
});
