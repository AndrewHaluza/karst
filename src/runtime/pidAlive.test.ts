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
});
