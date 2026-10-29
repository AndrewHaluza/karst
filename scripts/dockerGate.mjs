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

import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseRerunArgv, classifyFailures, failingScreenshots, planBaseCheck, reportLines } from './baseDrift.mjs';
import { hasBinary } from './onPath.mjs';
import { gateGrep, parseListTotal, readSettingsSections, selectViews, selectionLine } from './uiViews.mjs';
import {
  VOLUME_PREFIX,
  acquireSlot,
  nodeModulesVolumeName,
  release,
  slotPath,
  volumesToRemove,
  withNamedNodeModules,
} from './playwrightSlot.mjs';

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

/** Docker's container-name length cap, in practice (DNS label). */
const MAX_NAME_LENGTH = 63;

/**
 * Prefix of every gate container. Must NOT start with `karst-t`: the orphan
 * reaper kills /^karst-t(\d+)-/ as ticket service containers (D75).
 */
export const GATE_CONTAINER_PREFIX = 'karst-pw-';

/** Lowercase, docker's [a-z0-9_.-] set only, repeats collapsed, no edge dashes. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `karst-pw-<gate>-<who>-<pid>`: gate = the npm script without `test:`, who =
 * the ticket (else the worktree directory), pid keeps concurrent runs apart.
 */
export function gateContainerName({ event, ticket, cwd = process.cwd(), pid = process.pid }) {
  const gate = slug((event ?? '').replace(/^test:/, '')) || 'gate';
  const head = `${GATE_CONTAINER_PREFIX}${gate}-`;
  const tail = `-${pid}`;
  const room = Math.max(1, MAX_NAME_LENGTH - head.length - tail.length);
  const who = slug(slug(ticket || basename(cwd)).slice(0, room)) || 'gate';
  return `${head}${who}${tail}`;
}

/** Inject `--name <name>` right after `run`, unless the caller named it. */
export function withContainerName(argv, name) {
  if (argv[0] !== 'run') return argv;
  if (argv.some((arg) => arg === '--name' || arg.startsWith('--name='))) return argv;
  return ['run', '--name', name, ...argv.slice(1)];
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

/** Gate scripts whose sweep narrows to the views the ticket diff can reach. */
const SELECTING_SCRIPTS = new Set(['test:visual:docker', 'test:layout:docker']);

const BASE_CANDIDATES = ['origin/develop', 'develop', 'origin/main', 'main'];

/** The sha the ticket branched from, or null when no base ref resolves. */
export function mergeBaseSha(cwd = process.cwd(), base = process.env.KARST_BASE_REF) {
  for (const ref of base ? [base] : BASE_CANDIDATES) {
    const mb = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd, encoding: 'utf8' });
    if (mb.status === 0) return mb.stdout.trim();
  }
  return null;
}

/** Paths the ticket changed vs its base (committed, staged, unstaged, untracked), or null when unreadable. */
export function changedPaths(cwd = process.cwd(), base = process.env.KARST_BASE_REF) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const sha = mergeBaseSha(cwd, base);
  if (sha === null) return null;
  const tracked = git(['diff', '--name-only', '-z', sha]);
  const untracked = git(['ls-files', '-o', '--exclude-standard', '-z']);
  if (tracked.status !== 0 || untracked.status !== 0) return null;
  return `${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean);
}

/** `playwright test --list` totals with and without the grep, or null (best effort: the line just omits counts). */
function countTests(script, grep) {
  const project = script === 'test:layout:docker' ? ['--project=layout'] : [];
  const total = (env) => {
    const run = spawnSync('npx', ['playwright', 'test', '--list', ...project], { encoding: 'utf8', env });
    return run.status === 0 ? parseListTotal(run.stdout) : null;
  };
  const all = total({ ...process.env, KARST_UI_GREP: '' });
  const selected = grep === null ? all : total({ ...process.env, KARST_UI_GREP: grep });
  return all === null || selected === null ? null : { selected, total: all };
}

/** Narrow the sweep (KARST_UI_GREP, read by playwright.config.ts) and say so. Unknown diff = full. */
export function narrowSweep(script) {
  if (!SELECTING_SCRIPTS.has(script) || process.env.KARST_UI_GREP !== undefined) return;
  // A ledger seed/prune must see the full run (its full-run guard refuses a partial one).
  if (process.env.KARST_LAYOUT_SEED || process.env.KARST_LAYOUT_PRUNE) return;
  const paths = changedPaths();
  const selection = paths === null ? { all: true, views: [] } : selectViews(paths);
  let grep = null;
  try {
    grep = gateGrep(selection, readSettingsSections());
  } catch {
    // Unreadable section list: run the full sweep.
  }
  if (grep !== null) process.env.KARST_UI_GREP = grep;
  console.error(
    selectionLine(script, grep === null ? { all: true, views: [] } : selection, countTests(script, grep)),
  );
}

/**
 * The docker argv for the base re-run: the same image, flags and node_modules
 * volume, the base worktree mounted for the ticket's checkout, and playwright
 * run on just the failing screenshots in place of the gate's command.
 */
export function baseRunArgv(rawArgv, baseDir, screenshots, name, volume = null) {
  const image = rawArgv.findIndex((arg) => arg.includes('/playwright:'));
  const head = image === -1 ? rawArgv : rawArgv.slice(0, image + 1);
  const mounted = dockerArgv(head, baseDir);
  return withContainerName(
    [...(volume ? withNamedNodeModules(mounted, volume) : mounted), '/bin/sh', '-c', `(test -e node_modules/.package-lock.json || npm ci) && ${baseRerunArgv(screenshots).map(shellQuote).join(' ')}`],
    name,
  );
}

const shellQuote = (arg) => `'${arg.replace(/'/g, `'\\''`)}'`;

function main(argv) {
  const script = process.env.npm_lifecycle_event ?? 'this gate';
  narrowSweep(script);
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
  runContainer(local ? local.rest : argv);
}

/** The lockfile hash of a directory, or null when it has none. */
function lockVolume(dir) {
  try {
    return nodeModulesVolumeName(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Remove karst-pw-nm volumes no worktree references (the newest 2 stay). Best effort. */
function collectVolumes(cwd) {
  const list = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `name=${VOLUME_PREFIX}`], { encoding: 'utf8' });
  if (list.status !== 0) return;
  const names = list.stdout.split('\n').filter(Boolean);
  const trees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' }).stdout ?? '';
  const referenced = new Set(
    trees.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => lockVolume(l.slice(9))).filter(Boolean),
  );
  const volumes = names.map((name) => {
    const info = spawnSync('docker', ['volume', 'inspect', '--format', '{{.CreatedAt}}', name], { encoding: 'utf8' });
    return { name, createdAt: info.stdout.trim() };
  });
  for (const name of volumesToRemove(volumes, referenced)) spawnSync('docker', ['volume', 'rm', name], { stdio: 'ignore' });
}

async function runContainer(rawArgv) {
  const ticket = process.env.KARST_TICKET;
  const name = gateContainerName({ event: process.env.npm_lifecycle_event, ticket });
  const volume = lockVolume(process.cwd());
  const dockerArgs = dockerArgv(rawArgv);
  const args = withContainerName(volume ? withNamedNodeModules(dockerArgs, volume) : dockerArgs, name);
  const slot = slotPath();
  const abort = new AbortController();
  let holding = false;
  const forceRemove = () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  const cleanup = () => {
    if (holding) release(slot);
    holding = false;
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      abort.abort();
      forceRemove();
      cleanup();
      process.exit(130);
    });
  }
  // Timers only: the wait never blocks, so signals keep working while queued.
  holding = await acquireSlot(slot, {
    signal: abort.signal,
    onWait: () => console.error(`waiting for visual slot (ticket ${ticket ?? basename(process.cwd())})`),
  });
  if (!holding) process.exit(130);
  const results = join(process.cwd(), RESULTS_REL);
  rmSync(results, { force: true });
  // Async spawn: spawnSync would block the signal handlers above until docker exits.
  const run = (dockerArgs, env = process.env) =>
    new Promise((resolve) => {
      const child = spawn('docker', dockerArgs, { stdio: 'inherit', env });
      child.on('error', (error) => {
        cleanup();
        console.error(`docker could not start: ${error.message}`);
        process.exit(EXIT_COMMAND_NOT_FOUND);
      });
      child.on('close', (status) => resolve(status ?? 1));
    });
  let status = await run(args);
  if (status !== 0) status = await judgeAgainstBase({ status, rawArgv, name, volume, run, results });
  cleanup();
  if (status === 0) collectVolumes(process.cwd());
  process.exit(status);
}

const RESULTS_REL = join('tests', 'visual', '.results.json');
const BASELINES_REL = 'tests/visual/__baselines__';

const readReport = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Baselines the ticket added or changed vs its merge base (never drift: they keep the approval flow). */
function ownBaselines(cwd, sha) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const tracked = git(['diff', '--name-only', sha, '--', BASELINES_REL]);
  const untracked = git(['ls-files', '-o', '--exclude-standard', '--', BASELINES_REL]);
  return new Set(`${tracked.stdout ?? ''}\n${untracked.stdout ?? ''}`.split('\n').filter(Boolean));
}

/**
 * A failed sweep, re-judged: re-run only the failing screenshots in a detached
 * worktree of the merge base, inside the slot this process already holds. Ones
 * that fail there too are develop's drift (reported, not failed). Returns the
 * exit status: 0 when only drift remains, else the original one. The worktree
 * is always removed.
 */
async function judgeAgainstBase({ status, rawArgv, name, volume, run, results }) {
  const cwd = process.cwd();
  const report = readReport(results);
  if (report === null) return status;
  const failing = failingScreenshots(report, cwd);
  const sha = mergeBaseSha(cwd);
  if (sha === null) return status;
  const plan = planBaseCheck(failing, ownBaselines(cwd, sha));
  if (plan.kind === 'skip') return status;
  if (plan.kind === 'fail') {
    console.error(`base check skipped: ${plan.reason}`);
    return status;
  }
  const baseDir = mkdtempSync(join(tmpdir(), 'karst-base-'));
  try {
    const add = spawnSync('git', ['worktree', 'add', '--detach', baseDir, sha], { cwd, encoding: 'utf8' });
    if (add.status !== 0) {
      console.error(`base check skipped: cannot create the base worktree: ${add.stderr?.trim()}`);
      return status;
    }
    console.error(`re-running ${failing.screenshots.length} failing screenshot(s) at the merge base ${sha.slice(0, 12)}`);
    const baseStatus = await run(baseRunArgv(rawArgv, baseDir, failing.screenshots, `${name}-base`, volume), {
      ...process.env,
      KARST_UI_GREP: '',
    });
    const baseReport = readReport(join(baseDir, RESULTS_REL));
    if (baseReport === null) {
      console.error(`base check skipped: the base run left no report (exit ${baseStatus})`);
      return status;
    }
    const verdict = classifyFailures(failing.screenshots, baseReport);
    for (const line of reportLines(verdict)) console.error(line);
    return verdict.breaks.length === 0 ? 0 : status;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', baseDir], { cwd, stdio: 'ignore' });
    rmSync(baseDir, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd, stdio: 'ignore' });
  }
}

if (process.argv[1] && process.argv[1].endsWith('dockerGate.mjs')) {
  main(process.argv.slice(2));
}
