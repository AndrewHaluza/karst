import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalDockerPlan } from './evalDocker.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_IMAGE = 'karst-uat-host:local';
const EVAL_IMAGE = 'karst-uat-host-eval:local';
let evalPlan = null;
try {
  evalPlan = evalDockerPlan(process.argv.slice(2), repoRoot);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}
const IMAGE = evalPlan ? EVAL_IMAGE : BASE_IMAGE;
const runArgs = evalPlan ? evalPlan.forwarded : process.argv.slice(2);
const name = `karst-uat-host-${process.pid}`;

const buildImage = (tag, file) => spawnSync('docker', ['build', '-t', tag, '-f', file, '.'], { cwd: repoRoot, stdio: 'inherit' });
for (const [tag, file] of [[BASE_IMAGE, 'docker/uat-host/Dockerfile'], ...(evalPlan ? [[EVAL_IMAGE, 'docker/uat-host/Dockerfile.eval']] : [])]) {
  const build = buildImage(tag, file);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const forceRemove = () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { forceRemove(); process.exit(130); });
}

// Runs must not be concurrent against one checkout (shared karst-uat-vscode volume and bind-mounted dist/).
forceRemove(); // a stale container from PID reuse must not collide
const child = spawn('docker', [
  'run', '--rm', '--init', '--name', name,
  '-e', `HOST_UID=${process.getuid?.() ?? 0}`, '-e', `HOST_GID=${process.getgid?.() ?? 0}`,
  '-v', `${repoRoot}:/work`,
  '-v', '/work/node_modules',          // container-private addon (arch:ABI-01/ABI-03)
  '-v', 'karst-uat-vscode:/vscode-cache',
  ...(evalPlan ? evalPlan.dockerArgs : []),
  IMAGE, ...runArgs,
], { cwd: repoRoot, stdio: 'inherit' });

child.on('error', (err) => { console.error(`docker run failed: ${err.message}`); forceRemove(); process.exit(1); });
child.on('exit', (code) => { forceRemove(); process.exit(code ?? 1); });
