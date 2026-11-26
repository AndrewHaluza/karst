import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatePaths, killGateScript, sweepScript } from './sshGateScript.js';

/**
 * The kill and sweep scripts against a real process group under every remote
 * `/bin/sh` flavour on this machine. dash (Debian and Ubuntu `/bin/sh`)
 * rejects `kill -- -<pgid>`, so a script that uses `--` leaves the gate alive.
 */

const run = promisify(execFile);
const RUN_ID = 'abcdef0123456789';
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((s) => existsSync(s));

let ws: string;
let group: ChildProcess | undefined;

/** A detached `sleep`: its pid is the id of a new process group. */
async function startGroup(): Promise<{ pid: number; exited: Promise<void> }> {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  group = child;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return { pid: child.pid!, exited };
}

function within(ms: number, p: Promise<void>): Promise<'exited' | 'alive'> {
  return Promise.race([p.then(() => 'exited' as const), new Promise<'alive'>((r) => setTimeout(() => r('alive'), ms))]);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'karst-ssh-gate-'));
});

afterEach(async () => {
  if (group?.exitCode === null && group.signalCode === null) group.kill('SIGKILL');
  group = undefined;
  await rm(ws, { recursive: true, force: true });
});

describe.each(SHELLS)('gate kill under %s', (shell) => {
  it('killGateScript ends the group and removes its pgid file', async () => {
    const { pid, exited } = await startGroup();
    const { pgidFile } = gatePaths(ws, RUN_ID);
    await writeFile(pgidFile, `${String(pid)}\n`);
    await run(shell, ['-c', killGateScript(ws, RUN_ID, pid, 2)]);
    expect(await within(3000, exited)).toBe('exited');
    expect(await readdir(ws)).toEqual([]);
  }, 15_000);

  it('sweepScript ends an orphan group', async () => {
    const { pid, exited } = await startGroup();
    await writeFile(gatePaths(ws, RUN_ID).pgidFile, `${String(pid)}\n`);
    await run(shell, ['-c', sweepScript(ws, [])]);
    expect(await within(3000, exited)).toBe('exited');
    expect(await readdir(ws)).toEqual([]);
  }, 15_000);
});
