import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultHarnessExec } from './harnessExec.js';

const cwd = mkdtempSync(join(tmpdir(), 'harness-exec-'));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('defaultHarnessExec', () => {
  it('runs the command in cwd with the added env and captures both streams', async () => {
    const r = await defaultHarnessExec('echo "$KARST_HARNESS_NAME"; pwd -P; echo e >&2; exit 4', {
      cwd,
      env: { KARST_HARNESS_NAME: 'sbx' },
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toContain('sbx');
    expect(r.stderr).toContain('e');
    expect(r.timedOut).toBe(false);
  });
  it('kills a command that outlives the timeout', async () => {
    const r = await defaultHarnessExec('sleep 30', { cwd, env: {}, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
  });
  it('stops a command when the signal aborts', async () => {
    const ac = new AbortController();
    const p = defaultHarnessExec('sleep 30', { cwd, env: {}, timeoutMs: 20_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await p).exitCode).not.toBe(0);
  });
  it('settles when the command backgrounds a process that keeps the output open', async () => {
    const started = Date.now();
    const r = await defaultHarnessExec('echo up; sleep 30 & echo "{}"', { cwd, env: {}, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('up');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  it('kills the whole process group on timeout', async () => {
    const r = await defaultHarnessExec('sleep 30 & sleep 30', { cwd, env: {}, timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
  });
});
