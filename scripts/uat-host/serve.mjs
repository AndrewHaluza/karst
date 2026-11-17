// `npm run -s uat:host:serve -- --port <n>` (arch:UATHOST-08): one live UAT host container per worktree.
// Attached `docker run -i`: this process ending closes the container's stdin and stops it (killTree sends SIGKILL).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVE_DOCKERFILE, SERVE_IMAGE, checkoutKey, fixtureArgsFor, parseDockerPort, parseServeArgs, serveContainerName, serveDockerArgs,
} from './servePlan.mjs';

const EXIT_USAGE = 2;
const EXIT_NO_DOCKER = 3;
const RESET_REQUEST_TIMEOUT_MS = 10000; // the reset runs in the container; karst stops a reset command after 30 s (HOST_RESET_TIMEOUT_MS)

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const name = serveContainerName(root);
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

let plan;
try {
  plan = parseServeArgs(process.argv.slice(2), root);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT_USAGE);
}

if (docker(['info']).status !== 0) {
  console.error('uat-serve: docker is not available (docker info failed)');
  process.exit(EXIT_NO_DOCKER);
}

async function resetMode(body) {
  const out = docker(['port', name, '8080/tcp']);
  const port = out.status === 0 ? parseDockerPort(out.stdout) : null;
  if (!port) {
    console.error(`uat-serve: no running serve container for this checkout (${name})`);
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/reset?wait=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESET_REQUEST_TIMEOUT_MS),
    });
    console.log(await res.text());
    process.exit(res.status === 202 ? 0 : 1);
  } catch (err) {
    console.error(`uat-serve: reset request failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (plan.mode === 'reset') {
  await resetMode(plan.body);
}

docker(['rm', '-f', name], { stdio: 'ignore' }); // a leftover container of this checkout: it holds the port and answers /health with a foreign instance token during the build
const build = docker(['build', '-t', SERVE_IMAGE, '-f', SERVE_DOCKERFILE, '.'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('uat-serve: docker build failed');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'karst-uat-serve-'));
const cidfile = join(tmp, 'container.cid');
const argv = serveDockerArgs({
  name, cidfile, key: checkoutKey(root), port: plan.port, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
  root, fixtureArgs: fixtureArgsFor(plan), env: process.env,
});
const child = spawn('docker', argv, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => { /* container already gone */ });
// Hold the container's stdin open ourselves. Never forward our own stdin: karst
// starts a service with stdin closed, and that EOF would stop the host at once.
// When this process ends (signal, crash or SIGKILL), the OS closes the pipe and
// the container sees EOF and stops.

let removed = false;
function removeOwn() {
  if (removed) return;
  removed = true;
  try {
    const id = readFileSync(cidfile, 'utf8').trim();
    if (id) docker(['rm', '-f', id], { stdio: 'ignore' });
  } catch { /* the container never started */ }
  rmSync(tmp, { recursive: true, force: true });
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    removeOwn();
    process.exit(0);
  });
}
child.on('error', (err) => {
  console.error(`uat-serve: docker run failed — ${err.message}`);
  removeOwn();
  process.exit(1);
});
child.on('exit', (code, signal) => {
  removeOwn();
  process.exit(code ?? (signal ? 1 : 0));
});
