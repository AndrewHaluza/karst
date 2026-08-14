import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnHeadlessCli } from './headlessSpawn.js';

/** A fake child with real stdout/stderr EventEmitters, like claude.test.ts. */
function fakeChild(pid = 4242): EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('spawnHeadlessCli', () => {
  it('resolves stdout/stderr and the exit code on a clean close', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out'));
        child.stderr.emit('data', Buffer.from('err'));
        child.emit('close', 3);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await spawnHeadlessCli('codex', ['exec'], '/wt/a', {}, spawnImpl);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3 });
    expect(spawnImpl).toHaveBeenCalledWith('codex', ['exec'], {
      cwd: '/wt/a',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  });

  it('rejects with an AbortError when the signal fires mid-run and kills the group', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(process, 'kill');
    const spawnImpl = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 50);
      return child;
    }) as unknown as typeof spawn;
    const controller = new AbortController();

    const promise = spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { signal: controller.signal },
      spawnImpl,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(killed).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    const spawnImpl = vi.fn(() => fakeChild()) as unknown as typeof spawn;
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnHeadlessCli('codex', ['exec'], '/wt/a', { signal: controller.signal }, spawnImpl),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects with a timed-out error when the child never exits and kills the group', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(process, 'kill');
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;

    const promise = spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { timeoutMs: 20, terminationGraceMs: 50 },
      spawnImpl,
    );
    await expect(promise).rejects.toThrow(/timed out after 20ms/);
    expect(killed).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('bounds stdout to maxOutputBytes and appends the truncation marker', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('x'.repeat(2000)));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { maxOutputBytes: 1024 },
      spawnImpl,
    );
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 64);
    expect(result.stdout).toContain('[output truncated]');
    expect(result.exitCode).toBe(0);
  });

  it('emits onDebug lines for spawn, abort, and the close that follows the kill', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(process, 'kill');
    const spawnImpl = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 20);
      return child;
    }) as unknown as typeof spawn;
    const controller = new AbortController();
    const lines: string[] = [];

    const promise = spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { signal: controller.signal, onDebug: (m) => lines.push(m) },
      spawnImpl,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(killed).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(lines.some((line) => /spawned codex \(pid 4242/.test(line))).toBe(true);
    expect(lines.some((line) => /abort requested/.test(line))).toBe(true);
    expect(lines.some((line) => /close after abort kill/.test(line))).toBe(true);
  });

  it('emits a timeout onDebug line naming the deadline when the child hangs', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const lines: string[] = [];

    await expect(
      spawnHeadlessCli(
        'codex',
        ['exec'],
        '/wt/a',
        { timeoutMs: 10, terminationGraceMs: 5, onDebug: (m) => lines.push(m) },
        spawnImpl,
      ),
    ).rejects.toThrow(/timed out after 10ms/);

    expect(lines.some((line) => /timed out after 10ms/.test(line))).toBe(true);
  });

  it('delivers decoded stdout/stderr chunks through onOutput as they arrive', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out-1\n'));
        child.stderr.emit('data', Buffer.from('err-1\n'));
        child.stdout.emit('data', Buffer.from('out-2\n'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];

    const result = await spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { onOutput: (chunk) => chunks.push(chunk) },
      spawnImpl,
    );
    expect(chunks).toEqual([
      { stream: 'stdout', text: 'out-1\n' },
      { stream: 'stderr', text: 'err-1\n' },
      { stream: 'stdout', text: 'out-2\n' },
    ]);
    // The bounded buffers still hold the same bytes the seam captured.
    expect(result.stdout).toBe('out-1\nout-2\n');
    expect(result.stderr).toBe('err-1\n');
  });

  it('decodes multibyte characters split across chunks without replacement chars', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        // The smiley's 4 UTF-8 bytes arrive split across two data events.
        child.stdout.emit('data', Buffer.from('a \xf0\x9f', 'binary'));
        child.stdout.emit('data', Buffer.from('\x98\x80 z', 'binary'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;
    const chunks: { stream: 'stdout' | 'stderr'; text: string }[] = [];

    await spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { onOutput: (chunk) => chunks.push(chunk) },
      spawnImpl,
    );
    expect(chunks.map((c) => c.text).join('')).toBe('a 😀 z');
  });

  it('does not call onOutput when none is supplied', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    await spawnHeadlessCli('codex', ['exec'], '/wt/a', {}, spawnImpl);
  });

  it('notifies onSpawned with the pid and runs its disposer when the process settles', async () => {
    const child = fakeChild(5555);
    const dispose = vi.fn();
    const onSpawned = vi.fn(() => dispose);
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof spawn;

    await spawnHeadlessCli('codex', ['exec'], '/wt/a', { onSpawned }, spawnImpl);
    expect(onSpawned).toHaveBeenCalledWith(5555);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs the onSpawned disposer on the abort path too', async () => {
    const child = fakeChild(5556);
    const killed = vi.spyOn(process, 'kill');
    const dispose = vi.fn();
    const onSpawned = vi.fn(() => dispose);
    const spawnImpl = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 50);
      return child;
    }) as unknown as typeof spawn;
    const controller = new AbortController();

    const promise = spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { signal: controller.signal, onSpawned },
      spawnImpl,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(onSpawned).toHaveBeenCalledWith(5556);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(killed).toHaveBeenCalledWith(-5556, 'SIGKILL');
  });
});

describe('spawnHeadlessCli (real processes)', () => {
  /** Poll a pid file written by the child; rejects if it never appears. */
  async function waitForPidFile(path: string, deadlineMs = 2_000): Promise<number> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        const pid = Number(readFileSync(path, 'utf8').trim());
        if (Number.isInteger(pid)) return pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`pid file ${path} never appeared`);
  }

  /**
   * Poll until the pid is gone. A SIGKILLed process stays findable via
   * `kill(pid, 0)` while it is a not-yet-reaped zombie, so a one-shot assertion
   * right after the child's 'close' races the grandchild's reap — the group
   * kill's goal is eventual death, which is what this waits for. Same pattern
   * as gates/run.test.ts's expectProcessDead.
   */
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

  it('kills the whole process group on abort, including a grandchild', async () => {
    // The child spawns a grandchild that would survive a plain child.kill();
    // the group kill must take both down. Same pattern as gates/run.test.ts.
    const pidFile = join(tmpdir(), `karst-hs-${process.pid}-${Date.now()}.pid`);
    const script =
      `const{spawn}=require("node:child_process");const fs=require("node:fs");` +
      `const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));` +
      `setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const promise = spawnHeadlessCli(
      process.execPath,
      ['-e', script],
      process.cwd(),
      { signal: controller.signal, terminationGraceMs: 5_000 },
    );
    const grandchild = await waitForPidFile(pidFile);
    expect(process.kill(grandchild, 0)).toBe(true); // alive before the abort
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await expectProcessDead(grandchild);
    unlinkSync(pidFile);
  });

  it('kills a hung child on timeout and rejects with the deadline named', async () => {
    const promise = spawnHeadlessCli(
      process.execPath,
      ['-e', 'setInterval(()=>{},1e9)'],
      process.cwd(),
      { timeoutMs: 150, terminationGraceMs: 5_000 },
    );
    await expect(promise).rejects.toThrow(/timed out after 150ms/);
  });
});
