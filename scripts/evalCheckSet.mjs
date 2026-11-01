#!/usr/bin/env node
// Gold-patch sanity check for the pinned eval task set (evals/README.md).
//
// Runs the upstream Multi-SWE-bench harness once per instance (x --runs) with
// the upstream gold `fix_patch` and reports drifted instances: any instance
// whose gold patch is not reported "resolved" on every run. Drifted instances
// are excluded from scoring and listed in the D293 report. Pass --control to
// run a no-op patch instead: it must come back unresolved (negative control).
//
// No karst runner involved: this shells out to the harness python only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCES_DIR = join(ROOT, 'evals', 'instances');
const REPORTS_DIR = join(ROOT, 'evals', 'reports');
const DEFAULT_PYTHON = join(ROOT, 'evals', '.harness', 'venv', 'bin', 'python');

// A new empty file: applies cleanly, changes nothing the tests exercise.
export const NOOP_PATCH =
  'diff --git a/.eval-noop b/.eval-noop\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/.eval-noop\n@@ -0,0 +1 @@\n+noop\n';

/** Harness id of an upstream row, e.g. "vuejs/core:pr-11813". */
export function harnessId(row) {
  return `${row.org}/${row.repo}:pr-${row.number}`;
}

/** Patch line the harness reads: the upstream gold patch, or the no-op control. */
export function patchLine(row, kind) {
  const fix_patch = kind === 'control' ? NOOP_PATCH : row.fix_patch;
  return { org: row.org, repo: row.repo, number: row.number, fix_patch };
}

/** Harness config for a single-instance run rooted at `dir`. */
export function buildConfig(dir) {
  return {
    mode: 'evaluation',
    workdir: join(dir, 'work'),
    patch_files: [join(dir, 'patch.jsonl')],
    dataset_files: [join(dir, 'dataset.jsonl')],
    force_build: false,
    output_dir: join(dir, 'out'),
    specifics: [],
    skips: [],
    repo_dir: join(dir, 'repos'),
    need_clone: false,
    global_env: [],
    clear_env: true,
    stop_on_error: true,
    max_workers: 1,
    max_workers_build_image: 1,
    max_workers_run_instance: 1,
    log_dir: join(dir, 'logs'),
    log_level: 'INFO',
  };
}

/** 'resolved' | 'unresolved' | 'error' from a harness final_report.json. */
export function classifyReport(report, id) {
  if (report?.resolved_ids?.includes(id)) return 'resolved';
  if (report?.unresolved_ids?.includes(id)) return 'unresolved';
  return 'error';
}

/** Gold must resolve on every run; the control must never resolve. */
export function isDrifted(outcomes, kind) {
  if (outcomes.length === 0) return true;
  return kind === 'control'
    ? outcomes.some((o) => o !== 'unresolved')
    : outcomes.some((o) => o !== 'resolved');
}

export function summarize(results, kind) {
  const drifted = results.filter((r) => isDrifted(r.outcomes, kind)).map((r) => r.id);
  return { kind, total: results.length, drifted, passing: results.length - drifted.length };
}

export function parseArgs(argv) {
  const opts = { set: null, runs: 1, only: [], control: false, keepImages: false, python: DEFAULT_PYTHON };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--set') opts.set = next();
    else if (a === '--runs') opts.runs = Number.parseInt(next(), 10);
    else if (a === '--only') opts.only = next().split(',').filter(Boolean);
    else if (a === '--python') opts.python = next();
    else if (a === '--control') opts.control = true;
    else if (a === '--keep-images') opts.keepImages = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
  return opts;
}

/** Rows named by `only` (all rows when empty); an id that matches nothing is an error, never a silent 0/0 pass. */
export function selectRows(rows, only) {
  if (only.length === 0) return rows;
  const known = new Set(rows.map(harnessId));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`no instance matches: ${unknown.join(', ')}`);
  return rows.filter((r) => only.includes(harnessId(r)));
}

function findSet(explicit) {
  if (explicit) return resolve(explicit);
  const sets = readdirSync(INSTANCES_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  if (sets.length === 0) throw new Error(`no *.jsonl set in ${INSTANCES_DIR}`);
  return join(INSTANCES_DIR, sets[sets.length - 1]);
}

function readRows(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runHarness(python, row, kind) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-check-'));
  try {
    for (const d of ['work', 'out', 'logs', 'repos']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'dataset.jsonl'), `${JSON.stringify(row)}\n`);
    writeFileSync(join(dir, 'patch.jsonl'), `${JSON.stringify(patchLine(row, kind))}\n`);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(buildConfig(dir)));
    const r = spawnSync(python, ['-m', 'multi_swe_bench.harness.run_evaluation', '--config', join(dir, 'config.json')], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const reportFile = join(dir, 'out', 'final_report.json');
    if (r.status !== 0 || !existsSync(reportFile)) return 'error';
    return classifyReport(JSON.parse(readFileSync(reportFile, 'utf8')), harnessId(row));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function removeImage(row) {
  const tag = `mswebench/${row.org}_m_${row.repo}:pr-${row.number}`.toLowerCase();
  spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (!existsSync(opts.python)) {
    process.stderr.write(`harness python not found: ${opts.python}\nrun: npm run -s eval:setup\n`);
    return 2;
  }
  const file = findSet(opts.set);
  const kind = opts.control ? 'control' : 'gold';
  const rows = selectRows(readRows(file), opts.only);
  const results = [];
  for (const row of rows) {
    const outcomes = [];
    for (let i = 0; i < opts.runs; i++) outcomes.push(runHarness(opts.python, row, kind));
    if (!opts.keepImages) removeImage(row);
    results.push({ id: harnessId(row), outcomes });
    process.stdout.write(`${kind} ${harnessId(row)}: ${outcomes.join(',')}\n`);
  }
  const summary = { set: file.slice(ROOT.length + 1), ...summarize(results, kind), results };
  mkdirSync(REPORTS_DIR, { recursive: true });
  const out = join(REPORTS_DIR, `check-set-${kind}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${summary.passing}/${summary.total} pass; drifted: ${summary.drifted.join(', ') || 'none'}\nreport: ${out.slice(ROOT.length + 1)}\n`);
  return summary.drifted.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
