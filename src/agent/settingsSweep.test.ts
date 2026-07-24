import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepHookSettings } from './settingsSweep.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('sweepHookSettings', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'karst-sweep-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Write a hook-settings file and backdate it by `ageDays`. */
  function seed(name: string, ageDays: number): string {
    const path = join(dir, name);
    writeFileSync(path, '{}');
    const when = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(path, when, when);
    return path;
  }

  it('removes hook-settings files older than the cutoff', () => {
    seed('karst-hooks.4000.settings.json', 30);
    seed('karst-hooks.4000.a1b2c3d4e5f60718.settings.json', 30);
    expect(sweepHookSettings(dir, 7)).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps recent files — another window may be about to launch with one', () => {
    seed('karst-hooks.4000.settings.json', 1);
    expect(sweepHookSettings(dir, 7)).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('never touches files it did not write', () => {
    seed('karst.db', 90);
    seed('karst-hooks.settings.json', 90); // the pre-port legacy name
    seed('something-else.json', 90);

    sweepHookSettings(dir, 7);

    expect(readdirSync(dir).sort()).toEqual([
      'karst-hooks.settings.json',
      'karst.db',
      'something-else.json',
    ]);
  });

  it('is a no-op on a directory that does not exist', () => {
    expect(sweepHookSettings(join(dir, 'nope'), 7)).toBe(0);
  });

  it('sweeps only the stale files in a mixed directory', () => {
    seed('karst-hooks.4000.settings.json', 30);
    seed('karst-hooks.5000.settings.json', 1);
    expect(sweepHookSettings(dir, 7)).toBe(1);
    expect(readdirSync(dir)).toEqual(['karst-hooks.5000.settings.json']);
  });
});
