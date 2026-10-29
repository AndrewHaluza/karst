import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSlot, nodeModulesVolumeName, release, slotPath, tryAcquire, volumesToRemove, withNamedNodeModules,
} from './playwrightSlot.mjs';

const dir = () => join(mkdtempSync(join(tmpdir(), 'karst-slot-')), 'slot.lock');

describe('nodeModulesVolumeName', () => {
  it('is keyed by the lockfile content, 12 hex chars', () => {
    expect(nodeModulesVolumeName('a')).toMatch(/^karst-pw-nm-[0-9a-f]{12}$/);
    expect(nodeModulesVolumeName('a')).toBe(nodeModulesVolumeName('a'));
    expect(nodeModulesVolumeName('a')).not.toBe(nodeModulesVolumeName('b'));
  });
  it('replaces only the anonymous node_modules volume', () => {
    expect(withNamedNodeModules(['-v', '/work/node_modules', '-w', '/work'], 'v1')).toEqual(['-v', 'v1:/work/node_modules', '-w', '/work']);
  });
});

describe('volumesToRemove', () => {
  const v = (name, createdAt) => ({ name, createdAt });
  it('keeps referenced and the newest 2, removes the rest, ignores foreign volumes', () => {
    const all = [v('karst-pw-nm-a', '1'), v('karst-pw-nm-b', '2'), v('karst-pw-nm-c', '3'), v('karst-pw-nm-d', '4'), v('other', '0')];
    expect(volumesToRemove(all, new Set(['karst-pw-nm-a']))).toEqual(['karst-pw-nm-b']);
  });
});

describe('slot lock', () => {
  it('acquires, blocks a second live holder, releases', () => {
    const p = dir();
    expect(tryAcquire(p, 111, () => true)).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('111');
    expect(tryAcquire(p, 222, () => true)).toBe(false);
    release(p, 222);
    expect(existsSync(p)).toBe(true);
    release(p, 111);
    expect(existsSync(p)).toBe(false);
  });
  it('takes over a stale slot whose pid is dead', () => {
    const p = dir();
    writeFileSync(p, '999');
    expect(tryAcquire(p, 222, () => false)).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('222');
  });
  it('treats an unreadable holder as stale', () => {
    const p = dir();
    writeFileSync(p, 'junk');
    expect(tryAcquire(p, 5, () => true)).toBe(true);
  });
  it('waits, announces once, and acquires after release', async () => {
    const p = dir();
    tryAcquire(p, 111, () => true);
    let waits = 0;
    const pending = acquireSlot(p, { pid: 222, alive: () => true, pollMs: 5, onWait: () => waits++ });
    await new Promise((r) => setTimeout(r, 30));
    release(p, 111);
    expect(await pending).toBe(true);
    expect(waits).toBe(1);
  });
  it('gives up when aborted', async () => {
    const p = dir();
    tryAcquire(p, 111, () => true);
    const ac = new AbortController();
    const pending = acquireSlot(p, { pid: 222, alive: () => true, pollMs: 5, signal: ac.signal });
    ac.abort();
    expect(await pending).toBe(false);
  });
  it('places the file next to the karst db', () => {
    expect(slotPath({ KARST_DB: '/g/karst.db' })).toBe('/g/playwright-slot.lock');
  });
});
