#!/usr/bin/env node
// `npm run eval -- --instances <file.jsonl> --variant <name>... --runs N`
// Karst as a SWE-bench-style agent: upstream instance → ticket → pipeline (in the UAT container, D290)
// → patch → predictions-<variant>-<run>.jsonl → official harness on the HOST → report with karst metrics.
// Runs are strictly sequential (@arch:UATHOST-01: one shared karst-uat-vscode volume and dist/).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInstances, SETS } from './instances.mjs';
import { addWorktree, buildSnapshot, worktreePatch } from './snapshot.mjs';
import { installCommand, installDockerArgs } from './install.mjs';
import { buildFixture, buildSteps, loadVariant } from './variants.mjs';
import { attemptMetrics, readRunState, runStatsCli } from './endState.mjs';
import { renderReport } from './report.mjs';
import { scoreMultiSweBench, scoreSwePolyBench } from './score.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_IMAGE = 'karst-uat-host-eval:local';
const DEFAULTS = { runs: 1, perInstanceMin: 45, budgetMin: 480 };

export function parseArgs(argv) {
  const o = {
    instances: null, variants: [], runs: DEFAULTS.runs, only: [], core: null, evalEnv: [], authDir: null,
    perInstanceMin: DEFAULTS.perInstanceMin, budgetMin: DEFAULTS.budgetMin, outDir: null, python: join(ROOT, 'evals', '.harness', 'venv', 'bin', 'python'),
    fakeCore: false, noScore: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--') continue;
    else if (a === '--instances') o.instances = next();
    else if (a === '--variant') o.variants.push(next());
    else if (a === '--runs') o.runs = Number.parseInt(next(), 10);
    else if (a === '--only') o.only = next().split(',').filter(Boolean);
    else if (a === '--core') o.core = next();
    else if (a === '--eval-env') o.evalEnv.push(next());
    else if (a === '--eval-auth-dir') o.authDir = next();
    else if (a === '--per-instance-minutes') o.perInstanceMin = Number(next());
    else if (a === '--budget-minutes') o.budgetMin = Number(next());
    else if (a === '--out') o.outDir = next();
    else if (a === '--python') o.python = next();
    else if (a === '--fake-core') o.fakeCore = true;
    else if (a === '--no-score') o.noScore = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.instances) throw new Error('--instances <file.jsonl> is required');
  if (o.variants.length === 0) o.variants = ['default'];
  if (new Set(o.variants).size !== o.variants.length) throw new Error('--variant given twice');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs must be a positive integer');
  for (const [n, v] of [['--per-instance-minutes', o.perInstanceMin], ['--budget-minutes', o.budgetMin]]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${n} must be a positive number`);
  }
  if (o.fakeCore) o.noScore = true;
  return o;
}

/** Time left for one attempt: the per-instance cap, shrunk by what the whole-run budget has left. */
export function attemptBudgetMs({ perInstanceMin, budgetMin, elapsedMs }) {
  return Math.min(perInstanceMin * 60_000, budgetMin * 60_000 - elapsedMs);
}

const rel = (p) => relative(ROOT, p);

/** Real executors. Tests pass fakes for the same four seams. */
export const realExec = {
  /** Lockfile install in the eval image on <taskDir>/wt. Returns {ok, detail}. */
  install({ taskDir, argv }) {
    const r = spawnSync('docker', installDockerArgs({ taskDir, image: EVAL_IMAGE, argv }), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, detail: `${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n')}`.slice(0, 600) };
  },
  /** One container run; resolves {timedOut, code}. Own process group; SIGTERM, then SIGKILL, then docker rm. */
  uat({ args, budgetMs }) {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'uat-host', 'docker.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      let timedOut = false;
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
      const term = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => {
          kill('SIGKILL');
          spawnSync('docker', ['rm', '-f', `karst-uat-host-${child.pid}`], { stdio: 'ignore' });
        }, 20_000).unref();
      }, Math.max(budgetMs, 1_000));
      child.once('exit', (code) => { clearTimeout(term); resolveRun({ timedOut, code }); });
      child.once('error', () => { clearTimeout(term); resolveRun({ timedOut, code: 1 }); });
    });
  },
  stats: (a) => runStatsCli(a),
  score({ set, rows, predictionsPath, python }) {
    if (set === 'multi-swe-bench') return scoreMultiSweBench({ rows, predictionsPath, python, harnessId: SETS[set].harnessId });
    return scoreSwePolyBench();
  },
};

function uatArgs({ o, variant, dirs, taskDir, budgetMs, evalCore }) {
  const base = [
    '--fixture-file', rel(dirs.fixture), '--script', rel(dirs.steps), '--out', rel(dirs.probe), '--db-out', rel(dirs.db),
    '--probe-total-ms', String(budgetMs), '--probe-max-step-ms', String(budgetMs), '--hard-timeout-ms', String(budgetMs + 60_000),
  ];
  if (o.fakeCore) return base;
  return [
    '--eval', evalCore, '--eval-task', taskDir, ...o.evalEnv.flatMap((n) => ['--eval-env', n]), ...(o.authDir ? ['--eval-auth-dir', o.authDir] : []),
    '--eval-result', rel(dirs.record), ...base,
  ];
}

/**
 * One instance × variant × run. Never throws for a run-level failure: every failure becomes a recorded
 * end, so evidence always exists. Returns the attempt record (resolved is filled in by scoring).
 */
export async function runAttempt({ item, variant, run, o, attemptDir, exec, elapsedMs, fetchTree }) {
  const { task } = item;
  const dirs = {
    fixture: join(attemptDir, 'fixture.json'), steps: join(attemptDir, 'steps.json'), probe: join(attemptDir, 'probe'),
    db: join(attemptDir, 'karst.db'), record: join(attemptDir, 'run-record.json'), patch: join(attemptDir, 'patch.diff'),
  };
  mkdirSync(attemptDir, { recursive: true });
  const rec = { instanceId: task.id, variant: variant.name, run, scoring: 'scored', end: 'incomplete', blockedKind: null, stage: null, reason: null, metrics: null, patch: null };
  const excluded = (kind, reason) => Object.assign(rec, { scoring: 'excluded', end: 'blocked', blockedKind: kind, reason });
  // The task dir lives OUTSIDE the checkout (UATHOST-03) and is mounted at /task.
  const taskDir = mkdtempSync(join(tmpdir(), 'karst-eval-task-'));
  const started = Date.now();
  try {
    let baseCommit;
    try {
      ({ baseCommit } = buildSnapshot({ taskDir, repoUrl: task.repoUrl, baseSha: task.baseSha, testPatch: task.testPatch, ...(fetchTree ? { fetchTree } : {}) }));
      addWorktree({ taskDir });
    } catch (err) {
      return excluded('setup-failed', `snapshot: ${err.message}`.slice(0, 500));
    }
    const wt = join(taskDir, 'wt');
    if (!o.fakeCore) {
      const argv = installCommand(wt);
      if (argv) {
        const inst = exec.install({ taskDir, argv });
        if (!inst.ok) return excluded('setup-failed', `install (${argv.join(' ')}): ${inst.detail}`);
      }
    }
    writeFileSync(dirs.fixture, `${JSON.stringify(buildFixture({ task, variant }), null, 2)}\n`);
    const budgetMs = attemptBudgetMs({ perInstanceMin: o.perInstanceMin, budgetMin: o.budgetMin, elapsedMs });
    writeFileSync(dirs.steps, `${JSON.stringify(buildSteps({ waitMs: Math.max(budgetMs - 200_000, 10_000) }), null, 2)}\n`);
    const evalCore = o.core ?? variant.provider;
    const ran = await exec.uat({ args: uatArgs({ o, variant, dirs, taskDir, budgetMs, evalCore }), budgetMs });
    const wallMs = Date.now() - started;
    const probeTimedOut = existsSync(join(dirs.probe, 'summary.json')) && JSON.parse(readFileSync(join(dirs.probe, 'summary.json'), 'utf8')).results.some((r) => r.status === 'timeout');
    if (existsSync(dirs.db)) {
      const state = await readRunState(dirs.db, { timedOut: ran.timedOut || probeTimedOut });
      Object.assign(rec, { end: state.end.outcome, blockedKind: state.end.blockedKind, stage: state.end.stage, reason: state.end.reason });
      try {
        rec.metrics = attemptMetrics({ stats: exec.stats({ dbPath: dirs.db, cliEntry: join(ROOT, 'dist', 'cli', 'main.js') }), sources: state.sources, stages: state.stages, wallMs });
      } catch (err) {
        rec.metrics = null;
        rec.reason = `${rec.reason ?? ''} [metrics unavailable: ${err.message}]`.trim();
      }
    } else {
      Object.assign(rec, { end: ran.timedOut ? 'timeout' : 'incomplete', reason: 'no karst.db was saved by the container run' });
    }
    // The patch is the worktree as it stands (uncommitted and new files included), also after a timeout.
    rec.patch = worktreePatch(wt, baseCommit);
    writeFileSync(dirs.patch, rec.patch);
    return rec;
  } finally {
    rmSync(taskDir, { recursive: true, force: true, maxRetries: 2 });
    if (existsSync(taskDir)) process.stderr.write(`eval: could not remove ${taskDir} (container-owned files); remove it by hand\n`);
  }
}

export async function main(argv, exec = realExec, now = () => new Date()) {
  const o = parseArgs(argv);
  const file = resolve(o.instances);
  let items = loadInstances(readFileSync(file, 'utf8'));
  const setName = items[0].set;
  if (o.only.length > 0) {
    const unknown = o.only.filter((id) => !items.some((i) => i.task.id === id));
    if (unknown.length > 0) throw new Error(`no instance matches: ${unknown.join(', ')}`);
    items = items.filter((i) => o.only.includes(i.task.id));
  }
  // Instances whose gold patch drifted (eval:check-set) are excluded from scoring and listed in the report.
  const driftFile = join(ROOT, 'evals', 'reports', 'check-set-gold.json');
  let drifted = [];
  if (existsSync(driftFile)) {
    const check = JSON.parse(readFileSync(driftFile, 'utf8'));
    if (check.set && resolve(ROOT, check.set) === file) drifted = check.drifted ?? [];
  }
  items = items.filter((i) => !drifted.includes(i.task.id));
  if (items.length === 0) throw new Error('no instances left to run');
  const variants = o.variants.map((n) => loadVariant(n, join(ROOT, 'evals', 'variants')));
  if (!o.noScore && !existsSync(o.python)) throw new Error(`harness python not found: ${o.python}\nrun: npm run -s eval:setup (or --no-score)`);
  const ts = now().toISOString().replace(/[:.]/g, '-');
  const outDir = o.outDir ? resolve(o.outDir) : join(ROOT, 'eval-results', ts);
  // The container bind-mounts only the checkout; evidence written elsewhere is discarded with it.
  if (relative(ROOT, outDir).startsWith('..')) throw new Error(`--out must be inside the checkout (${ROOT}): ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const attempts = [];
  const started = Date.now();
  let n = 0;
  outer: for (let run = 1; run <= o.runs; run++) {
    for (const variant of variants) {
      for (const item of items) {
        const elapsedMs = Date.now() - started;
        if (attemptBudgetMs({ perInstanceMin: o.perInstanceMin, budgetMin: o.budgetMin, elapsedMs }) < 60_000) {
          process.stderr.write('eval: whole-run budget exhausted; remaining attempts are not run\n');
          break outer;
        }
        const attemptDir = join(outDir, 'attempts', `${String(++n).padStart(3, '0')}-${variant.name}-r${run}-${item.task.id.replace(/[^A-Za-z0-9_.-]+/g, '_')}`);
        const rec = await runAttempt({ item, variant, run, o, attemptDir, exec, elapsedMs });
        attempts.push({ ...rec, item });
        if (rec.patch !== null && rec.scoring === 'scored') {
          appendFileSync(join(outDir, `predictions-${variant.name}-${run}.jsonl`), `${JSON.stringify(SETS[setName].predictionLine(item.row, rec.patch))}\n`);
        }
        process.stdout.write(`eval: ${rec.instanceId} ${variant.name} r${run}: ${rec.end}${rec.blockedKind ? `:${rec.blockedKind}` : ''}\n`);
      }
    }
  }
  if (!o.noScore) {
    for (const variant of variants) {
      for (let run = 1; run <= o.runs; run++) {
        const predictionsPath = join(outDir, `predictions-${variant.name}-${run}.jsonl`);
        if (!existsSync(predictionsPath)) continue;
        const rows = attempts.filter((a) => a.variant === variant.name && a.run === run).map((a) => a.item.row);
        const verdicts = exec.score({ set: setName, rows, predictionsPath, python: o.python });
        for (const a of attempts.filter((x) => x.variant === variant.name && x.run === run && x.scoring === 'scored')) {
          const v = verdicts.get(SETS[setName].harnessId(a.item.row));
          if (v === 'resolved' || v === 'unresolved') a.resolved = v === 'resolved';
          else Object.assign(a, { scoring: 'excluded', blockedKind: a.blockedKind ?? 'harness-error', reason: a.reason ?? 'harness gave no verdict' });
        }
      }
    }
  } else {
    // No harness ran (fake-core smoke or --no-score): nothing is claimed about quality.
    for (const a of attempts) if (a.scoring === 'scored') Object.assign(a, { scoring: 'excluded', blockedKind: a.blockedKind ?? 'unscored', reason: a.reason ?? 'no scoring requested' });
  }
  const cores = [...new Map(readCoreRecords(outDir).map((c) => [`${c.core} ${c.version}`, c])).values()];
  const clean = attempts.map(({ item, patch, ...a }) => a);
  const report = renderReport({
    meta: { setName, setVersion: basename(file).replace(/\.jsonl$/, ''), cores, variants: variants.map((v) => v.name), runs: o.runs, startedAt: now().toISOString(), excluded: drifted },
    attempts: clean,
  });
  writeFileSync(join(outDir, 'report.md'), report);
  writeFileSync(join(outDir, 'attempts.json'), `${JSON.stringify(clean, null, 2)}\n`);
  process.stdout.write(`eval: report ${rel(join(outDir, 'report.md'))}\n`);
  return 0;
}

function readCoreRecords(outDir) {
  const out = [];
  const base = join(outDir, 'attempts');
  if (!existsSync(base)) return out;
  for (const d of readdirSync(base)) {
    const p = join(base, d, 'run-record.json');
    if (existsSync(p)) {
      try {
        const r = JSON.parse(readFileSync(p, 'utf8'));
        out.push({ core: r.core, version: r.version });
      } catch { /* an unreadable record is simply absent */ }
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });
}
