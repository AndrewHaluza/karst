// Run the CI `Mutation score` delta gate on the files this ticket changed, before the impl marker.
// Usage: node scripts/mutationChanged.mjs   (npm run -s test:mutation:changed)
// Scope: files changed against the merge base with the base branch (uncommitted and untracked included),
// kept to the `mutate` set of stryker.config.json.
// Verdict: scripts/mutationGate.mjs decides, so the local rules and the CI rules cannot drift.
// Without a develop report, only a file that is new against the merge base must reach the break score.
// A modified file prints its score and a warning, because an old low-score file would fail each unrelated change.
// Exit: 0 with no changed mutate-set file, otherwise the exit code of the gate.
// `--lines` (npm run -s gate:mutation, @arch:GATE-MUTATION): the review gate. It mutates only the lines the
// ticket added and fails on an undetected mutant there, offline, with no develop report.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { MISSING_TOOL_STATUS, changedSince, git, mergeBase, runTool, splitZ } from './gateScope.mjs';
import { concurrencyFor, joinNearRanges, linesMarkdown, mutateSpecs, parseDiffRanges, verdictOnAddedLines } from './mutationLines.mjs';
import { DEFAULT_THRESHOLD, evaluate, loadSide, run as runGate } from './mutationGate.mjs';
import { loadThreshold } from './mutationSummary.mjs';

export const REPORT = 'reports/mutation/mutation.json';
export const INCREMENTAL_FILE = 'reports/stryker-incremental.json';
export const DEVELOP_DIR = 'reports/develop-mutation';
export const CHANGED_LIST = 'reports/mutation-changed.txt';
export const DEVELOP_RUNS_TRIED = 5;

/** One glob to a RegExp: `**` crosses a directory, `*` and `?` do not. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when the path matches a positive pattern and no `!` pattern. */
export function inMutateSet(path, patterns) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(path)) return false;
    } else if (globToRegExp(pattern).test(path)) included = true;
  }
  return included;
}

/** The changed paths that Stryker mutates and that still exist (a deleted file has no mutant). */
export function selectMutateFiles(changed, patterns, exists = () => true) {
  return [...new Set(changed)].filter((path) => inMutateSet(path, patterns) && exists(path)).sort();
}

/** The `stryker run` args for the scoped, incremental run. */
export function strykerArgs(files) {
  return ['stryker', 'run', '--mutate', files.join(','), '--incremental', '--incrementalFile', INCREMENTAL_FILE];
}

/** The one scope line. */
export const scopeMessage = (files, base) =>
  files.length === 0
    ? 'mutation:changed: no changed file in the Stryker mutate set, nothing to run'
    : `mutation:changed: ${files.length} changed mutate-set files since ${base.slice(0, 12)}`;

/** The files that are new against the merge base (added in the diff, or untracked). */
export async function addedSince(cwd, sha, gitFn = git) {
  const added = await gitFn(cwd, ['diff', '--name-only', '--diff-filter=A', '-z', sha]);
  const untracked = await gitFn(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (added === null || untracked === null) return null;
  return [...new Set([...splitZ(added), ...splitZ(untracked)])];
}

/**
 * Download the newest develop `mutation-develop` artifact into `dir`.
 * Any gh failure is not fatal: it returns null and the caller uses the fallback.
 */
export async function downloadDevelopReport(cwd, { exec = runQuiet, dir = DEVELOP_DIR, tries = DEVELOP_RUNS_TRIED } = {}) {
  rmSync(join(cwd, dir), { recursive: true, force: true });
  const listed = await exec('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', 'develop', '--event', 'push', '--status', 'completed', '--limit', '30', '--json', 'databaseId', '--jq', '.[].databaseId'], cwd);
  if (listed.status !== 0) return null;
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, tries);
  for (const id of ids) {
    const got = await exec('gh', ['run', 'download', id, '--name', 'mutation-develop', '--dir', dir], cwd);
    const report = join(cwd, dir, 'mutation.json');
    if (got.status === 0 && existsSync(report)) return report;
  }
  return null;
}

/** Run a command with captured stdout and no output; a start failure is status 127. */
export async function runQuiet(cmd, args, cwd) {
  const { execFile } = await import('node:child_process');
  return new Promise((done) => {
    execFile(cmd, args, { cwd, maxBuffer: 1 << 26 }, (err, stdout) => {
      if (!err) return done({ status: 0, stdout });
      done({ status: typeof err.code === 'number' ? err.code : 127, stdout: '' });
    });
  });
}

/**
 * Judge the run. With a develop report the gate sees every changed file.
 * Without one, the gate sees only the new files and a modified file gets its score and a warning.
 */
export function judge({ files, added, developReport, cwd, runGateFn = runGate, write = writeFileSync }) {
  const list = join(cwd, CHANGED_LIST);
  const base = { reportPath: join(cwd, REPORT), configPath: join(cwd, 'stryker.config.json'), changedPath: list, summaryPath: undefined };
  if (developReport) {
    write(list, `${files.join('\n')}\n`);
    return { ...runGateFn({ ...base, developReportPath: developReport }), warnings: [] };
  }
  const isNew = new Set(added);
  const gateFiles = files.filter((path) => isNew.has(path));
  const modified = files.filter((path) => !isNew.has(path));
  const warnings = [];
  if (modified.length > 0) warnings.push(...modifiedWarnings(modified, base));
  if (gateFiles.length === 0) return { exitCode: 0, markdown: '## Mutation score\n\nNo new file: nothing for the gate to judge without a develop report.', annotations: [], warnings };
  write(list, `${gateFiles.join('\n')}\n`);
  return { ...runGateFn({ ...base, developReportPath: undefined }), warnings };
}

function modifiedWarnings(modified, base) {
  const side = loadSide(base.reportPath, 'PR report');
  if (!side.files) return [`mutation:changed: ${side.reason}`];
  const threshold = loadThreshold(base.configPath, side.report) ?? DEFAULT_THRESHOLD;
  const rows = evaluate({ prFiles: side.files, developFiles: null, changedFiles: modified, threshold });
  return rows.map((row) => `mutation:changed: warning: ${row.path} scores ${row.score === null ? 'n/a' : row.score.toFixed(2)}, ${row.prUndetected} undetected. No develop report, so CI compares it with develop.`);
}

/** The whole flow. Every effect is a parameter, so a test stubs Stryker, gh and git. */
export async function mutationChanged({
  cwd = process.cwd(),
  mergeBaseFn = mergeBase,
  changedFn = changedSince,
  addedFn = addedSince,
  runToolFn = runTool,
  downloadFn = downloadDevelopReport,
  judgeFn = judge,
  exists = (path) => existsSync(join(cwd, path)),
  patterns = JSON.parse(readFileSync(join(cwd, 'stryker.config.json'), 'utf8')).mutate ?? [],
  log = (line) => console.error(line),
} = {}) {
  const { sha, tried } = await mergeBaseFn(cwd);
  if (sha === null) {
    log(`mutation:changed: no merge base for ${tried.join(', ')}`);
    return 1;
  }
  const changed = await changedFn(cwd, sha);
  if (changed === null) {
    log('mutation:changed: git diff failed');
    return 1;
  }
  const files = selectMutateFiles(changed, patterns, exists);
  log(scopeMessage(files, sha));
  if (files.length === 0) return 0;
  const added = await addedFn(cwd, sha);
  if (added === null) {
    log('mutation:changed: git diff failed');
    return 1;
  }
  rmSync(join(cwd, REPORT), { force: true });
  mkdirSync(join(cwd, 'reports'), { recursive: true });
  const strykerStatus = await runToolFn('npx', strykerArgs(files), cwd);
  // Stryker exits non-zero when the scoped score is below the break. The gate decides, not this status.
  if (strykerStatus !== 0) log(`mutation:changed: stryker exited ${strykerStatus}; the gate reads its report`);
  const developReport = await downloadFn(cwd);
  if (!developReport) log('mutation:changed: no develop report; only a new file must reach the break score');
  const verdict = judgeFn({ files, added, developReport, cwd });
  process.stdout.write(`${verdict.markdown}\n`);
  for (const line of [...verdict.annotations, ...verdict.warnings]) log(line);
  return verdict.exitCode;
}

// --- `--lines`: the review gate on the lines the ticket added (@arch:GATE-MUTATION) ---

export const GATE_REPORT = 'reports/mutation-lines/mutation.json';
export const GATE_CONFIG_FILE = 'stryker-lines.config.json';
export const GATE_STATE_FILE = 'stryker-lines.json';
export const GATE_STATE_DIR = 'karst-gate-state';
/** Root paths the gate-mode sandbox does not copy (Stryker does not read .gitignore; a leading / anchors at the root). The mutation tests read none of them: they build temp roots. */
export const GATE_IGNORES = ['/evals', '/eval-results', '/tests/visual', '/media', '/docs', '/scratch', '/spikes', '/sandbox', '/develop', '*.vsix'];
const NO_TESTS = 'No tests were executed';
const RUNNER_CRASHED = 'Test runner crashed';
const INITIAL_FAILED = 'There were failed tests in the initial test run';

/** The `stryker run` args (after the bin) for the gate. The config file sets the gate-only JSON report path (the CLI has no option for it). */
export function linesArgs({ specs, stateFile, configFile, concurrency, ignorePatterns, full, logLevel }) {
  return [
    'run', configFile, '--mutate', specs.join(','),
    '--incremental', '--incrementalFile', stateFile,
    '--reporters', 'json,progress-append-only',
    '--concurrency', String(concurrency),
    '--ignorePatterns', ignorePatterns.join(','),
    ...(full ? ['--force'] : []),
    ...(logLevel ? ['--logLevel', logLevel] : []),
  ];
}

/** Resolve the Stryker CLI script from cwd upward (no npx), or null. */
export function resolveStrykerBin(cwd) {
  try {
    const require = createRequire(join(cwd, 'package.json'));
    const pkg = require.resolve('@stryker-mutator/core/package.json');
    const bin = JSON.parse(readFileSync(pkg, 'utf8')).bin;
    return join(dirname(pkg), typeof bin === 'string' ? bin : bin.stryker);
  } catch {
    return null;
  }
}

/** Run a command, teeing its output to ours while capturing it; a start failure is status 127. */
export function spawnCapture(cmd, args, { cwd, env }) {
  return new Promise((done) => {
    let out = '';
    const child = spawn(cmd, args, { cwd, env });
    const sink = (stream) => (chunk) => {
      out += chunk;
      stream.write(chunk);
    };
    child.stdout.on('data', sink(process.stdout));
    child.stderr.on('data', sink(process.stderr));
    child.on('error', (err) => done({ status: MISSING_TOOL_STATUS, out: `${out}${err.message}` }));
    child.on('close', (status) => done({ status: status ?? 1, out }));
  });
}

/** Re-judge a failed dry run on the base: vitestGate re-runs the failing files at the merge base (@arch:GATE-OUTPUT). 0 = base drift. */
export function baseDriftRun(cwd, files) {
  return runTool(process.execPath, ['scripts/vitestGate.mjs', 'npx', 'vitest', 'related', '--run', '--config', 'vitest.mutation.config.ts', ...files], cwd);
}

const readGateReport = (cwd) => {
  const path = join(cwd, GATE_REPORT);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
};

/** Added ranges per mutate-set file: the tracked diff joined near, plus each untracked file whole. */
export function addedRanges({ diff, untracked, patterns, exists }) {
  const ranges = new Map();
  for (const [path, list] of parseDiffRanges(diff)) ranges.set(path, joinNearRanges(list));
  for (const path of untracked) ranges.set(path, null);
  for (const path of [...ranges.keys()]) if (!inMutateSet(path, patterns) || !exists(path)) ranges.delete(path);
  return ranges;
}

/** The gate flow. Every effect is a parameter, so a test stubs git, Stryker and the report. */
export async function mutationLines({
  cwd = process.cwd(),
  mergeBaseFn = mergeBase,
  gitFn = git,
  patterns = JSON.parse(readFileSync(join(cwd, 'stryker.config.json'), 'utf8')).mutate ?? [],
  exists = (path) => existsSync(join(cwd, path)),
  resolveBin = resolveStrykerBin,
  spawnFn = spawnCapture,
  driftFn = baseDriftRun,
  readReport = readGateReport,
  removeReport = () => rmSync(join(cwd, GATE_REPORT), { force: true }),
  prepare = (stateDir, configFile) => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(cwd, dirname(GATE_REPORT)), { recursive: true });
    const base = JSON.parse(readFileSync(join(cwd, 'stryker.config.json'), 'utf8'));
    writeFileSync(configFile, JSON.stringify({ ...base, jsonReporter: { fileName: GATE_REPORT } }));
  },
  cpus = availableParallelism(),
  env = process.env,
  ignorePatterns = [...(JSON.parse(readFileSync(join(cwd, 'stryker.config.json'), 'utf8')).ignorePatterns ?? []), ...GATE_IGNORES],
  log = (line) => console.error(line),
  print = (text) => process.stdout.write(`${text}\n`),
} = {}) {
  const { sha, tried } = await mergeBaseFn(cwd);
  if (sha === null) {
    log(`mutation: no merge base for ${tried.join(', ')}`);
    return 1;
  }
  const diff = await gitFn(cwd, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', sha]);
  const untracked = await gitFn(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (diff === null || untracked === null) {
    log('mutation: git diff failed');
    return 1;
  }
  const ranges = addedRanges({ diff, untracked: splitZ(untracked), patterns, exists });
  const files = [...ranges.keys()].sort();
  if (files.length === 0) {
    log('mutation: no changed line in the Stryker mutate set, nothing to run');
    return 0;
  }
  log(`mutation: ${files.length} files, branch diff since ${sha.slice(0, 12)}`);
  const gitDir = (await gitFn(cwd, ['rev-parse', '--absolute-git-dir']))?.trim();
  if (!gitDir) {
    log('mutation: git directory not found');
    return 1;
  }
  const bin = resolveBin(cwd);
  if (bin === null) {
    log('@stryker-mutator/core: command not found (not installed)');
    return MISSING_TOOL_STATUS;
  }
  const stateDir = join(gitDir, GATE_STATE_DIR);
  const configFile = join(stateDir, GATE_CONFIG_FILE);
  prepare(stateDir, configFile);
  removeReport();
  const args = linesArgs({ specs: mutateSpecs(ranges), stateFile: join(stateDir, GATE_STATE_FILE), configFile, concurrency: concurrencyFor(cpus, env), ignorePatterns, full: env.KARST_GATE_FULL === '1', logLevel: env.KARST_GATE_LOG_LEVEL });
  const run = await spawnFn(process.execPath, [bin, ...args], { cwd, env });
  const report = readReport(cwd);
  if (report === null) return noReport(run, files, driftFn, cwd, log);
  if (typeof report.files !== 'object' || report.files === null) {
    log('mutation: malformed report (no files)');
    return 1;
  }
  const verdict = verdictOnAddedLines(report, ranges);
  print(linesMarkdown(verdict));
  return verdict.failures.length === 0 ? 0 : 1;
}

/** Stryker left no report: name the known causes, never a bare "missing report". */
async function noReport(run, files, driftFn, cwd, log) {
  if (run.out.includes(NO_TESTS)) {
    log(`mutation: no test imports ${files.join(', ')}`);
    return 1;
  }
  if (run.out.includes(RUNNER_CRASHED)) {
    const signal = /\((SIG[A-Z0-9]+)\)/.exec(run.out)?.[1] ?? 'unknown signal';
    log(`mutation: the test runner crashed in the initial test run (${signal})`);
    return 1;
  }
  if (run.out.includes(INITIAL_FAILED)) {
    if ((await driftFn(cwd, files)) === 0) {
      log('mutation: the initial test run failed only on tests that also fail at the base (develop drift), so no mutant was judged');
      return 0;
    }
    log('mutation: the initial test run failed');
    return 1;
  }
  log(`mutation: no report (stryker exited ${run.status})`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('mutationChanged.mjs')) {
  process.exitCode = process.argv.includes('--lines') ? await mutationLines() : await mutationChanged();
}
