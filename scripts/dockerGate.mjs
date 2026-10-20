// Run a container-pinned gate script, or NAME the capability it needs.
//
// The visual and layout gates are container-pinned on purpose: the screenshot
// baselines are recorded in one pinned Playwright image and are valid for
// exactly that rendering environment (playwright.config.ts), so the sweep only
// means something inside that container.
//
// Two environments reach this script:
//   - a host with docker: the container runs, exactly as before;
//   - the karst sandbox, which has no docker (it never mounts the docker
//     socket). There the sweep can still run LOCALLY, but only where the
//     rendering environment is the one the baselines were recorded in — the
//     sandbox image carries that environment and says so with a marker file.
//     Anywhere else a local sweep would answer a different question (the
//     repo's own docs: never judge a visual failure from a host run), so the
//     script exits 127 and names the repair.
//
// Exit code: 127 — POSIX's "command not found" — so the caller can tell a
// missing capability from a failing test (karst parks on 127; see
// src/workflow/gates/capabilityGap.ts).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hasBinary } from './onPath.mjs';

/** POSIX's "command not found" exit code. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/** `{repo}` in the argument list stands for the directory the script runs in. */
export const REPO_PLACEHOLDER = '{repo}';

/**
 * The file the sandbox image writes when it IS the rendering environment the
 * baselines were recorded in (sandbox/opencode/Dockerfile).
 */
export const BASELINE_ENV_MARKER = '/opt/karst/visual-baseline-env';

/**
 * The sentence that names the missing capability and its repair.
 */
export function missingDockerMessage(script) {
  return (
    `${script} needs docker: the visual/layout baselines are recorded in the pinned Playwright container, ` +
    'so the sweep only means anything inside it. Install docker and run this gate on a host with it ' +
    '(the karst sandbox never mounts the docker socket), or run the gate in the sandbox image, which ' +
    'carries that rendering environment.'
  );
}

/** Is `docker` on PATH? */
export function hasDocker(pathEnv = process.env.PATH, platform = process.platform) {
  return hasBinary('docker', pathEnv, platform);
}

/**
 * Does this environment declare itself the rendering environment the baselines
 * belong to? Only then may a local sweep stand in for the container.
 */
export function isBaselineEnvironment(marker = BASELINE_ENV_MARKER) {
  return existsSync(marker);
}

/**
 * The docker argv for a gate script: the arguments with `{repo}` replaced by
 * the directory the script runs in.
 */
export function dockerArgv(argv, cwd = process.cwd()) {
  return argv.map((arg) => arg.split(REPO_PLACEHOLDER).join(cwd));
}

/**
 * The environment the container would have carried: the `-e KEY=VALUE` pairs
 * of the docker argv. The local run gets the same ones, so both paths see the
 * same environment (the layout gate's ledger intents travel this way).
 */
export function envFromDockerArgs(argv) {
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-e' || i + 1 >= argv.length) continue;
    const eq = argv[i + 1].indexOf('=');
    if (eq <= 0) continue;
    env[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
  }
  return env;
}

/** The `--local "<command>"` pair, if the script names one. */
export function readLocalCommand(argv) {
  const index = argv.indexOf('--local');
  if (index === -1 || index + 1 >= argv.length) return null;
  return { command: argv[index + 1], rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

/**
 * What the gate does, given what the environment offers.
 *
 * `docker` — run the container, exactly as before.
 * `local`  — no docker, but this container IS the rendering environment the
 *            baselines were recorded in: the sweep runs here and still means
 *            something.
 * `missing` — no docker and no such environment: the capability is absent,
 *            so the script names the repair and exits 127.
 */
export function gatePlan({ docker, baseline, local }) {
  if (docker) return { kind: 'docker' };
  if (local && baseline) return { kind: 'local', command: local.command, env: envFromDockerArgs(local.rest) };
  return { kind: 'missing' };
}

function main(argv) {
  const script = process.env.npm_lifecycle_event ?? 'this gate';
  const local = readLocalCommand(argv);
  const plan = gatePlan({
    docker: hasDocker(),
    baseline: isBaselineEnvironment(),
    local,
  });
  if (plan.kind === 'missing') {
    console.error(missingDockerMessage(script));
    process.exit(EXIT_COMMAND_NOT_FOUND);
  }
  if (plan.kind === 'local') {
    console.error(
      `${script}: docker is not installed here, but this container IS the rendering environment the ` +
        'baselines were recorded in — running the sweep locally.',
    );
    const result = spawnSync(plan.command, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...plan.env },
    });
    process.exit(result.status ?? 1);
  }
  const result = spawnSync('docker', dockerArgv(local ? local.rest : argv), { stdio: 'inherit' });
  if (result.error) {
    console.error(`docker could not start: ${result.error.message}`);
    process.exit(EXIT_COMMAND_NOT_FOUND);
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('dockerGate.mjs')) {
  main(process.argv.slice(2));
}
