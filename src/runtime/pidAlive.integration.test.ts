import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { pidAlive } from './pidAlive.js';

describe('pidAlive', () => {
  it('says a live process is alive', () => {
    // `process.pid` is this test runner's own process — it is running.
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('says a pid that does not exist is gone (ESRCH)', () => {
    // A pid so large no process can own it: `kill` answers ESRCH, never EPERM.
    expect(pidAlive(2 ** 31 - 1)).toBe(false);
  });

  it('says another live process is alive too — liveness is not ownership', () => {
    // A spawned child still executing answers the zero-signal probe: alive.
    // (The EPERM branch — exists but refused — is the same return value and
    // cannot be produced portably: it needs a process owned by another user.)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
      expect(pidAlive(child.pid ?? -1)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('says an exited-but-unreaped process is dead (a zombie holds nothing)', async () => {
    // `sh` exits and leaves its child orphaned; the child exits a moment later
    // and, on a host whose init never reaps an orphan (a container without an
    // init reaper), stays a ZOMBIE — a pid that still answers the zero-signal
    // probe for a process that is GONE. It holds no port, no file and no
    // compute, so it must not read as a live server.
    const child = spawn('sh', ['-c', 'sleep 0.2 & echo $!; exit 0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = await new Promise<number>((resolve) => {
      let out = '';
      child.stdout!.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('close', () => resolve(Number(out.trim())));
    });
    expect(pid).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!pidAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pidAlive(pid)).toBe(false);
  });
});
