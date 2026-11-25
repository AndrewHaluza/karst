import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_WALK_BUDGET_MS, storageUsage } from './probes.js';

let root: string;

const bytes = (name: string, size: number): void => writeFileSync(join(root, name), 'x'.repeat(size));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doctor-storage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const bytesOf = (entries: readonly { name: string; bytes: number }[], name: string): number | undefined =>
  entries.find((e) => e.name === name)?.bytes;

describe('storageUsage', () => {
  it('sums direct files and nested directories per direct child and in total', () => {
    mkdirSync(join(root, 'artifacts', 'nested', 'deeper'), { recursive: true });
    bytes('top.bin', 100);
    bytes(join('artifacts', 'a.bin'), 200);
    bytes(join('artifacts', 'nested', 'b.bin'), 300);
    bytes(join('artifacts', 'nested', 'deeper', 'c.bin'), 400);
    mkdirSync(join(root, 'empty-dir'));

    const usage = storageUsage(root);

    expect(usage.partial).toBe(false);
    expect(bytesOf(usage.entries, 'top.bin')).toBe(100);
    expect(bytesOf(usage.entries, 'artifacts')).toBe(900);
    expect(bytesOf(usage.entries, 'empty-dir')).toBe(0);
    expect(usage.totalBytes).toBe(1000);
    expect(usage.entries).toHaveLength(3);
  });

  it('returns an empty usage for an empty directory', () => {
    expect(storageUsage(root)).toEqual({ totalBytes: 0, entries: [], partial: false });
  });

  it('returns an empty usage for a missing root and never throws', () => {
    expect(storageUsage(join(root, 'does-not-exist'))).toEqual({ totalBytes: 0, entries: [], partial: false });
  });

  it('never follows a symlink to a directory, at the root or nested', () => {
    const target = mkdtempSync(join(tmpdir(), 'doctor-storage-target-'));
    try {
      writeFileSync(join(target, 'huge.bin'), 'x'.repeat(4096));
      symlinkSync(target, join(root, 'linked'));
      mkdirSync(join(root, 'plain'));
      writeFileSync(join(root, 'plain', 'own.bin'), 'x'.repeat(10));
      symlinkSync(target, join(root, 'plain', 'linked-again'));

      const usage = storageUsage(root);

      expect(bytesOf(usage.entries, 'linked')).toBe(0);
      expect(bytesOf(usage.entries, 'plain')).toBe(10);
      expect(usage.totalBytes).toBe(10);
      expect(usage.partial).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('never follows a symlink to a file', () => {
    mkdirSync(join(root, 'dir'));
    const target = join(root, 'dir', 'real.bin');
    writeFileSync(target, 'x'.repeat(1024));
    symlinkSync(target, join(root, 'link-to-file'));

    const usage = storageUsage(root);

    expect(bytesOf(usage.entries, 'link-to-file')).toBe(0);
    expect(bytesOf(usage.entries, 'dir')).toBe(1024);
    expect(usage.totalBytes).toBe(1024);
  });

  it.skipIf(process.getuid?.() === 0)('counts an unreadable child as 0 without throwing', () => {
    mkdirSync(join(root, 'unreadable'));
    writeFileSync(join(root, 'unreadable', 'hidden.bin'), 'x'.repeat(500));
    bytes('readable.bin', 5);
    chmodSync(join(root, 'unreadable'), 0o000);
    try {
      expect(lstatSync(join(root, 'unreadable')).isDirectory()).toBe(true);
      const usage = storageUsage(root);
      expect(bytesOf(usage.entries, 'unreadable')).toBe(0);
      expect(bytesOf(usage.entries, 'readable.bin')).toBe(5);
      expect(usage.totalBytes).toBe(5);
    } finally {
      chmodSync(join(root, 'unreadable'), 0o700);
    }
  });

  it('stops at the time budget and reports partial totals', () => {
    // start() = 0, then every later read is 1000 ms in: over a 10 ms budget.
    let calls = 0;
    const clock = (): number => (calls++ === 0 ? 0 : 1000);
    bytes('a.bin', 7);

    const usage = storageUsage(root, 10, clock);

    expect(usage).toEqual({ totalBytes: 0, entries: [], partial: true });
  });

  it('stops inside a directory walk at the exact budget and keeps what it counted', () => {
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'inner.bin'), 'x'.repeat(64));
    // start() = 0; the first child test is at 10 (< budget); the first entry
    // test inside the walk is at EXACTLY 20, which is already over a 20 ms budget.
    const readings = [0, 10, 20];
    let calls = 0;
    const clock = (): number => readings[Math.min(calls++, readings.length - 1)]!;

    const usage = storageUsage(root, 20, clock);

    expect(usage.partial).toBe(true);
    expect(usage.totalBytes).toBe(0);
    expect(usage.entries).toEqual([{ name: 'dir', bytes: 0 }]);
  });

  it('defaults to the exported walk budget', () => {
    expect(STORAGE_WALK_BUDGET_MS).toBe(10_000);
    expect(storageUsage(root)).toEqual({ totalBytes: 0, entries: [], partial: false });
  });
});
