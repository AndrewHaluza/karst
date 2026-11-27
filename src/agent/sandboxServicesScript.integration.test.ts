import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
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
  try {
    const { stderr } = await run('/bin/sh', ['-c', script, ...args], { timeout: 10_000 });
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karst-sd-'));
});

afterEach(async () => {
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
