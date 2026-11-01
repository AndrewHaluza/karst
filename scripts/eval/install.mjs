// Lockfile-detected dependency install, run by the EVAL LAYER in the container on the task worktree
// (not sandbox.setup: no sandbox exists and the container has no Docker socket).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** First matching lockfile wins; the frozen flag keeps the install from rewriting the lock. */
export const LOCKFILES = [
  { file: 'pnpm-lock.yaml', argv: ['pnpm', 'install', '--frozen-lockfile'] },
  { file: 'yarn.lock', argv: ['yarn', 'install', '--frozen-lockfile'] },
  { file: 'package-lock.json', argv: ['npm', 'ci'] },
];

/** argv for the install, or null when the checkout has no lockfile (nothing to install). */
export function installCommand(dir, exists = (p) => existsSync(p)) {
  const hit = LOCKFILES.find((l) => exists(join(dir, l.file)));
  return hit ? hit.argv : null;
}

/** `docker run` argv: the eval image, task dir mounted at /task, working in the worktree. */
export function installDockerArgs({ taskDir, image, argv }) {
  // corepack provides pnpm/yarn; npm ships with node. HOME is writable scratch.
  const script = `corepack enable >/dev/null 2>&1 || true; cd /task/wt && ${argv.join(' ')}`;
  return ['run', '--rm', '--init', '-v', `${taskDir}:/task`, '-e', 'HOME=/tmp', '-e', 'CI=1', '--entrypoint', 'sh', image, '-c', script];
}
