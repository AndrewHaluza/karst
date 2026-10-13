import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'karst-uat-host:local';
const name = `karst-uat-host-${process.pid}`;

const build = spawnSync('docker', ['build', '-t', IMAGE, '-f', 'docker/uat-host/Dockerfile', '.'], {
  cwd: repoRoot, stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn('docker', [
  'run', '--rm', '--init', '--name', name,
  '-v', `${repoRoot}:/work`,
  '-v', '/work/node_modules',          // container-private addon (arch:ABI-01/ABI-03)
  '-v', 'karst-uat-vscode:/vscode-cache',
  IMAGE, ...process.argv.slice(2),
], { cwd: repoRoot, stdio: 'inherit' });

const forceRemove = () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); };
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { forceRemove(); process.exit(130); });
}
child.on('exit', (code) => { forceRemove(); process.exit(code ?? 1); });
