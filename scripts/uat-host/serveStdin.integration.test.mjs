// serve.mjs runs as a karst manifest service, and the karst supervisor starts
// every service with stdin closed (`stdio: ['ignore', ...]`). The container must
// stay up in that case, and must still stop when serve.mjs ends.
// A fake `docker` on PATH stands in for the daemon: `run` waits on its stdin and
// records the EOF, so the test sees exactly what the container would see.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVE = join(repoRoot, 'scripts/uat-host/serve.mjs');
const SETTLE_MS = 800;
const WAIT_LIMIT_MS = 10_000;

const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const log = (line) => appendFileSync(process.env.FAKE_DOCKER_LOG, line + '\\n');
const [cmd, ...rest] = process.argv.slice(2);
log(cmd);
if (cmd === 'port') process.exit(1);
if (cmd !== 'run') process.exit(0);
const cid = rest[rest.indexOf('--cidfile') + 1];
writeFileSync(cid, 'fake-cid');
process.stdin.resume();
process.stdin.on('end', () => { log('stdin-eof'); process.exit(0); });
`;

let dir;
let child;

afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const logLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function waitFor(check) {
  const end = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return false;
}

describe('serve.mjs as a karst service (stdin closed)', () => {
  it('keeps the container stdin open, and closes it when serve.mjs ends', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-serve-stdin-'));
    const shim = join(dir, 'docker');
    writeFileSync(shim, FAKE_DOCKER);
    chmodSync(shim, 0o755);
    const logPath = join(dir, 'docker.log');

    child = spawn(process.execPath, [SERVE, '--port', '4999'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
    });

    expect(await waitFor(() => logLines(logPath).includes('run'))).toBe(true);
    await sleep(SETTLE_MS);
    expect(logLines(logPath)).not.toContain('stdin-eof');
    expect(child.exitCode).toBeNull();

    child.kill('SIGTERM');
    expect(await waitFor(() => logLines(logPath).includes('stdin-eof'))).toBe(true);
  }, 30_000);
});
