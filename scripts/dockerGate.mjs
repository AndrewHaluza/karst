// Run a container-pinned gate script, or NAME the capability it needs.
//
// The visual and layout gates are container-pinned on purpose: the screenshot
// baselines are recorded in one pinned Playwright image and are valid for
// exactly that rendering environment (playwright.config.ts), so the sweep only
// means something inside that container.
//
// The karst sandbox has no docker: it never mounts the docker socket, so a
// sandboxed ticket's `npm run test:visual:docker` died with the shell's terse
// "sh: 1: docker: not found" and the gate read as a red the ticket could not
// clear. This wrapper turns that into the two facts a reader needs: the
// capability is missing, and what installs it.
//
// Exit code: 127 — POSIX's "command not found" — so the caller can tell a
// missing capability from a failing test (karst parks on 127; see
// src/workflow/gates/capabilityGap.ts).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** POSIX's "command not found" exit code. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/** `{repo}` in the argument list stands for the directory the script runs in. */
export const REPO_PLACEHOLDER = '{repo}';

/**
 * The sentence that names the missing capability and its repair.
 */
export function missingDockerMessage(script) {
  return (
    `${script} needs docker: the visual/layout baselines are recorded in the pinned Playwright container, ` +
    'so the sweep only means anything inside it. Install docker and run this gate on a host with it ' +
    '(the karst sandbox never mounts the docker socket), or run the gate outside a sandbox.'
  );
}

/** Is `docker` on PATH? */
export function hasDocker(pathEnv = process.env.PATH) {
  return (pathEnv ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsSync(join(dir, 'docker')));
}

/**
 * The docker argv for a gate script: the arguments with `{repo}` replaced by
 * the directory the script runs in.
 */
export function dockerArgv(argv, cwd = process.cwd()) {
  return argv.map((arg) => arg.split(REPO_PLACEHOLDER).join(cwd));
}

function main(argv) {
  const script = process.env.npm_lifecycle_event ?? 'this gate';
  if (!hasDocker()) {
    console.error(missingDockerMessage(script));
    process.exit(EXIT_COMMAND_NOT_FOUND);
  }
  const result = spawnSync('docker', dockerArgv(argv), { stdio: 'inherit' });
  if (result.error) {
    console.error(`docker could not start: ${result.error.message}`);
    process.exit(EXIT_COMMAND_NOT_FOUND);
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('dockerGate.mjs')) {
  main(process.argv.slice(2));
}
