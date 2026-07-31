import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, runProcess } from './run.js';

function waitForPidFile(path: string): boolean {
  const readiness = new Int32Array(new SharedArrayBuffer(4));
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (!existsSync(path) && process.hrtime.bigint() < deadline) {
    Atomics.wait(readiness, 0, 0, 10);
  }
  return existsSync(path);
}

async function expectProcessDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('runCommand', () => {
  it('captures the exit code and combined output', async () => {
    const r = await runCommand('node', ['-e', 'process.stdout.write("out");process.stderr.write("err")'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('reports a nonzero exit code', async () => {
    const r = await runCommand('node', ['-e', 'process.exit(3)'], process.cwd());
    expect(r.exitCode).toBe(3);
  });

  it('treats a missing binary as a failure rather than throwing', async () => {
    const r = await runCommand('karst-no-such-binary-xyz', [], process.cwd());
    expect(r.exitCode).toBe(1);
    expect(r.output).not.toBe('');
  });

  // The whole point of this module: gates run inside the extension host, and the
  // hook endpoint + every webview live on the same event loop. A synchronous
  // spawn froze all of them for the length of `npm test` — sessions' hooks could
  // not be served, and the host looked dead to the IDE.
  it('leaves the event loop free while the child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await runCommand('node', ['-e', 'setTimeout(() => {}, 300)'], process.cwd());
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('terminates and reports a command that exceeds its deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-gate-ready-'));
    const pidFile = join(dir, 'child.pid');
    vi.useFakeTimers();
    const r = await (async () => {
      try {
        const pending = runCommand(
          'node',
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
              'process.stdout.write(`${process.pid}\\n`);setInterval(() => {}, 1_000)',
          ],
          process.cwd(),
          { timeoutMs: 10_000 },
        );
        const ready = waitForPidFile(pidFile);
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await pending;
        expect(ready).toBe(true);
        return result;
      } finally {
        vi.useRealTimers();
      }
    })();

    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('timed out after 10000ms');
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('terminates descendants when a timed-out command launches a grandchild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-gate-tree-ready-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = `
      const { writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      process.stdout.write(String(grandchild.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    vi.useFakeTimers();
    const r = await (async () => {
      try {
        const pending = runCommand('node', ['-e', script], process.cwd(), {
          timeoutMs: 10_000,
          terminationGraceMs: 500,
        });
        const ready = waitForPidFile(pidFile);
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await pending;
        expect(ready).toBe(true);
        return result;
      } finally {
        vi.useRealTimers();
      }
    })();
    const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);

    expect(r.exitCode).toBe(1);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expectProcessDead(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  });

  it('bounds retained noisy output and reports truncation exactly once', async () => {
    const maxOutputBytes = 128;
    const marker = '\n[output truncated]\n';
    const r = await runCommand(
      'node',
      ['-e', 'process.stdout.write("x".repeat(10_000));process.stderr.write("y".repeat(10_000))'],
      process.cwd(),
      { maxOutputBytes },
    );

    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(
      maxOutputBytes + Buffer.byteLength(marker),
    );
    expect(r.output.split(marker)).toHaveLength(2);
  });

  it('bounds invalid UTF-8 output without quadratic trimming', async () => {
    const maxOutputBytes = 32 * 1024;
    const marker = '\n[output truncated]\n';
    const r = await runCommand(
      'node',
      ['-e', 'process.stdout.write(Buffer.alloc(65_536, 255))'],
      process.cwd(),
      { maxOutputBytes },
    );

    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(
      maxOutputBytes + Buffer.byteLength(marker),
    );
    expect(r.output.split(marker)).toHaveLength(2);
  });

  it('keeps the normal result when child completion races its deadline', async () => {
    const result = runCommand(
      'node',
      ['-e', 'setTimeout(() => process.exit(0), 10)'],
      process.cwd(),
      { timeoutMs: 100 },
    );

    const r = await result;
    expect(r).toEqual({ exitCode: 0, output: '' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r).toEqual({ exitCode: 0, output: '' });
  });

  it('clears its deadline timer after normal completion', async () => {
    vi.useFakeTimers();
    try {
      const result = runCommand(
        'node',
        ['-e', 'process.exit(0)'],
        process.cwd(),
        { timeoutMs: 60_000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toMatchObject({ exitCode: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its deadline timer after a spawn error', async () => {
    vi.useFakeTimers();
    try {
      const result = runCommand(
        'karst-no-such-binary-timer-cleanup',
        [],
        process.cwd(),
        { timeoutMs: 60_000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toMatchObject({ exitCode: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runProcess', () => {
  it('reports a clean exit as completed with its code', async () => {
    const out = await runProcess('node', ['-e', 'process.exit(3)'], process.cwd());
    expect(out).toMatchObject({ kind: 'completed', exitCode: 3 });
  });

  it('reports a missing binary as spawnFailed, never as a nonzero gate', async () => {
    const out = await runProcess('karst-no-such-binary-xyz', [], process.cwd());
    expect(out.kind).toBe('spawnFailed');
  });

  it('reports an aborted child as aborted, not as a failing gate', async () => {
    const controller = new AbortController();
    const started = runProcess(
      'node',
      ['-e', 'setTimeout(() => {}, 60_000)'],
      process.cwd(),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const out = await started;
    expect(out.kind).toBe('aborted');
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const out = await runProcess('node', ['-e', ''], process.cwd(), {
      signal: AbortSignal.abort(),
    });
    expect(out.kind).toBe('aborted');
  });

  it('runCommand still reduces a spawn failure to exit 1', async () => {
    const r = await runCommand('karst-no-such-binary-xyz', [], process.cwd());
    expect(r.exitCode).toBe(1);
  });
});
