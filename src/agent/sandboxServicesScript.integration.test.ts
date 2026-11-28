import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { START_SCRIPT_SD, STOP_SCRIPT_SD } from './sandboxServices.js';

/**
 * The `_SD` service scripts against a real `/bin/sh` (D823). They spawn `sh`,
 * so this is an integration test. The point is the state dir: every pid and log
 * file lives under it, the dir is 0700, and a planted symlink is refused
 * instead of read.
 */

const run = promisify(execFile);
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((s) => existsSync(s));

/** The background service writes asynchronously: read the log until it has content. */
async function logContent(path: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const text = await readFile(path, 'utf8');
      if (text !== '') return text;
    } catch {
      /* not created yet */
    }
    if (Date.now() > deadline) return '';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function shell(script: string, ...args: string[]): Promise<{ code: number; stderr: string }> {
  return shellWith('/bin/sh', script, ...args);
}

async function shellWith(sh: string, script: string, ...args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(sh, ['-c', script, ...args], { timeout: 10_000 });
    return { code: 0, stderr };
  } catch (error) {
    const err = error as { code?: unknown; stderr?: unknown };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.stderr ?? ''),
    };
  }
}

let root: string;
let group: ChildProcess | undefined;

/**
 * A new process group: the leader `sh` waits on a background `sleep`. Its pid
 * is the pgid; `member` is the `sleep`, which a leader-only kill leaves alive.
 */
async function startGroup(): Promise<{ leader: number; member: number }> {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  group = child;
  const member = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', (chunk: Buffer) => resolve(Number.parseInt(chunk.toString('utf8'), 10)));
    child.once('error', reject);
  });
  return { leader: child.pid!, member };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karst-sd-'));
});

afterEach(async () => {
  if (group?.pid !== undefined) {
    try {
      process.kill(-group.pid, 'SIGKILL');
    } catch {
      /* the group already ended */
    }
  }
  group = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('the _SD service scripts under a real sh', () => {
  it.each(SHELLS)('keeps its pid and log files under the state dir (%s)', async (sh) => {
    const sd = join(root, 'svc');
    // `sh` in the argument list is a stand-in for the service command; it exits
    // at once, so no process is left behind on a host without `setsid`.
    const start = await shell(START_SCRIPT_SD, 'karst-svc', sd, 'api', root, sh, '-c', 'echo ready');
    expect(start).toMatchObject({ code: 0 });
    expect((await stat(sd)).mode & 0o777).toBe(0o700);
    const pid = (await readFile(join(sd, 'karst-svc-api.pid'), 'utf8')).trim();
    expect(pid).toMatch(/^\d+$/);
    expect(await logContent(join(sd, 'karst-svc-api.log'))).toContain('ready');
    const stop = await shell(STOP_SCRIPT_SD, 'karst-svc-stop', sd, 'api');
    expect(stop).toMatchObject({ code: 0 });
  });

  it('refuses a symlinked state dir instead of logging into it', async () => {
    const real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const sd = join(root, 'svc');
    await symlink(real, sd);
    const stop = await shell(STOP_SCRIPT_SD, 'karst-svc-stop', sd, 'api');
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain('symlink');
    const start = await shell(START_SCRIPT_SD, 'karst-svc', sd, 'api', root, '/bin/sh', '-c', 'echo hi');
    expect(start.code).toBe(1);
    expect(start.stderr).toContain('symlink');
    // Nothing was written through the link.
    expect(existsSync(join(real, 'karst-svc-api.pid'))).toBe(false);
  });
});

/** dash (Debian and Ubuntu `/bin/sh`) rejects `kill -- -<pgid>`: only the leader would end. */
describe.each(SHELLS)('the _SD scripts signal the whole service group under %s', (sh) => {
  it('STOP_SCRIPT_SD ends every process of the group', async () => {
    const sd = join(root, 'svc');
    await mkdir(sd, { mode: 0o700 });
    const { leader, member } = await startGroup();
    await writeFile(join(sd, 'karst-svc-api.pid'), `${String(leader)}\n`);
    expect(await shellWith(sh, STOP_SCRIPT_SD, 'karst-svc-stop', sd, 'api')).toMatchObject({ code: 0 });
    expect(await gone(member)).toBe(true);
    expect(existsSync(join(sd, 'karst-svc-api.pid'))).toBe(false);
  }, 15_000);

  it('START_SCRIPT_SD ends every process of the previous instance', async () => {
    const sd = join(root, 'svc');
    await mkdir(sd, { mode: 0o700 });
    const { leader, member } = await startGroup();
    await writeFile(join(sd, 'karst-svc-api.pid'), `${String(leader)}\n`);
    expect(await shellWith(sh, START_SCRIPT_SD, 'karst-svc', sd, 'api', root, '/bin/sh', '-c', 'exit 0')).toMatchObject({ code: 0 });
    expect(await gone(member)).toBe(true);
  }, 15_000);

  // `1` is left out: a regression would signal every process of the user.
  it('a pid file that holds no valid process group signals nothing and still succeeds', async () => {
    const sd = join(root, 'svc');
    await mkdir(sd, { mode: 0o700 });
    const { member } = await startGroup();
    for (const bad of ['', 'abc', '0', '-5', `${String(member)} 1`]) {
      await writeFile(join(sd, 'karst-svc-api.pid'), `${bad}\n`);
      expect(await shellWith(sh, STOP_SCRIPT_SD, 'karst-svc-stop', sd, 'api')).toMatchObject({ code: 0 });
    }
    expect(alive(member)).toBe(true);
  }, 15_000);
});
