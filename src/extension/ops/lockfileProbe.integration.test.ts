import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKFILES_SH } from './sandboxSetupOp.js';

function probe(files: string[]): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'lockprobe-'));
  for (const f of files) writeFileSync(join(dir, f), '');
  return new Promise((resolve) => {
    execFile('sh', ['-c', LOCKFILES_SH], { cwd: dir }, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0));
  });
}

describe('LOCKFILES_SH (real sh)', () => {
  it('succeeds when any one lockfile exists, fails when none does', async () => {
    expect(await probe(['package-lock.json'])).toBe(0);
    expect(await probe(['pnpm-lock.yaml'])).toBe(0);
    expect(await probe(['yarn.lock'])).toBe(0);
    expect(await probe([])).not.toBe(0);
  });
});
