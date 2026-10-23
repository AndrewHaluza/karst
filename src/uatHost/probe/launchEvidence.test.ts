import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLaunches } from './launchEvidence.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('readLaunches', () => {
  it('is empty without the env or the file', () => {
    expect(readLaunches({})).toEqual([]);
    const d = mkdtempSync(join(tmpdir(), 'launch-ev-')); dirs.push(d);
    expect(readLaunches({ KARST_UAT_LAUNCH_DIR: d })).toEqual([]);
  });
  it('reads and normalizes recorded launches', () => {
    const d = mkdtempSync(join(tmpdir(), 'launch-ev-')); dirs.push(d);
    writeFileSync(join(d, 'launches.ndjson'),
      `${JSON.stringify({ provider: 'claude', argv: [], envKeys: [], cwd: '/t/workspace-0123abcd' })}\n`);
    expect(readLaunches({ KARST_UAT_LAUNCH_DIR: d })).toEqual([
      { provider: 'claude', argv: [], envKeys: [], cwd: '/t/workspace-<hash>' },
    ]);
  });
});
