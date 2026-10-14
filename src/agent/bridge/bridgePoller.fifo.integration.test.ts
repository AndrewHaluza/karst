import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgePoller } from './bridgePoller.js';

const run = promisify(execFile);

let dir: string; let file: string; let stateFile: string;
let logs: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fifo-'));
  file = join(dir, 'events.ndjson'); stateFile = join(dir, 'state.json');
  logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('bridgePoller with a planted FIFO', () => {
  it('refuses a FIFO without blocking, and stop() still resolves', async () => {
    await run('mkfifo', [file]);
    const lines: string[] = [];
    const p = createBridgePoller({ file, stateFile, intervalMs: 5, onLine: (l) => lines.push(l), debug: (m) => logs.push(m) });
    await p.pollOnce();
    p.start();
    await p.stop();
    expect(lines).toEqual([]);
    expect(logs.some((m) => m.startsWith('[bridge]'))).toBe(true);
  });
});
