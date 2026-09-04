import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // 5s of polling, not 0.5s: under the unit gate's parallel load a SIGKILLed
  // grandchild stays a findable zombie well past 500ms, and the group kill's
  // contract is eventual death.
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    // The deadline is a FAKE timer so the race is deterministic: the child is
    // real and exits on its own, and advancing past the deadline afterwards
    // proves a late timeout can never overwrite the settled completion. A real
    // 100ms deadline against a real 10ms child blew up under parallel load,
    // where the node spawn alone can exceed the deadline — the timeout won,
    // and the "normal completion wins the race" property it claims to pin was
    // only ever tested on a machine faster than the gate's.
    vi.useFakeTimers();
    try {
      const result = runCommand(
        'node',
        ['-e', 'setTimeout(() => process.exit(0), 10)'],
        process.cwd(),
        { timeoutMs: 100 },
      );

      // The child completes in real time; the fake deadline cannot fire early.
      await vi.advanceTimersByTimeAsync(0);
      const r = await result;
      expect(r).toEqual({ exitCode: 0, output: '' });
      // Past the deadline: the timer was cleared on completion, so the result
      // is NOT overwritten by a late timeout.
      await vi.advanceTimersByTimeAsync(150);
      expect(r).toEqual({ exitCode: 0, output: '' });
    } finally {
      vi.useRealTimers();
    }
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

  // spawn() validates synchronously and THROWS for a structurally invalid
  // command (empty string) rather than emitting the async 'error' event a
  // missing-but-well-formed binary gets above. Without a try/catch around the
  // spawn call this rejects the returned promise instead of resolving
  // spawnFailed — an unhandled rejection, not a reported outcome.
  it('reports an empty command as spawnFailed instead of throwing', async () => {
    const out = await runProcess('', [], process.cwd());
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
    controller.abort();
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

describe('relative gate commands', () => {
  // A project-local toolchain (Python's `.venv/bin/`, `./gradlew`) is the
  // ordinary case outside Node. On POSIX this already worked — libuv chdirs
  // into the child's cwd before execvp — and these tests pin that, because
  // `resolveCommandCwd` now rewrites the command before the spawn and must not
  // change the answer here. Its actual fix is on Windows, where the lookup in
  // `resolveOnPath` runs against the extension host's cwd; that path is
  // covered by `runtime/command.test.ts`.
  it('runs a command relative to the gate cwd, not the process cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-relcmd-'));
    try {
      const script = join(dir, 'gate.sh');
      writeFileSync(script, '#!/bin/sh\nexit 7\n');
      chmodSync(script, 0o755);
      const r = await runCommand('./gate.sh', [], dir);
      expect(r.exitCode).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still lets PATH answer a bare command name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-barecmd-'));
    try {
      const r = await runCommand('node', ['-e', 'process.exit(0)'], dir);
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runProcess live output', () => {
  it('streams stdout and stderr chunks as they arrive, before the process closes', async () => {
    const chunks: { stream: string; text: string }[] = [];
    const outcome = await runProcess(
      'node',
      ['-e', 'process.stdout.write("live-out\\n");process.stderr.write("live-err\\n")'],
      process.cwd(),
      { onOutput: (chunk) => chunks.push(chunk) },
    );
    expect(outcome.kind).toBe('completed');
    expect(chunks.map((c) => c.stream).sort()).toEqual(['stderr', 'stdout']);
    expect(chunks.map((c) => c.text).join('')).toContain('live-out');
    expect(chunks.map((c) => c.text).join('')).toContain('live-err');
  });
});
