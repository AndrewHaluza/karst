import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SETS, detectSet, loadInstances } from './instances.mjs';
import { FORBIDDEN_TOP, addWorktree, assertCleanSnapshot, buildSnapshot, copyTreeFetcher, git, patchFiles, worktreePatch } from './snapshot.mjs';
import { installCommand, installDockerArgs } from './install.mjs';
import { LOW_CONFIDENCE_N, pairwiseDeltas, passAtK, perResolved, summarizeVariant } from './stats.mjs';
import { attemptMetrics, readRunState } from './endState.mjs';
import { buildFixture, buildSteps, loadVariant, parseVariant } from './variants.mjs';
import { renderReport } from './report.mjs';
import { ROOT, attemptBudgetMs, main, parseArgs } from './run.mjs';
import { parseFixtureFile } from '../../src/uatHost/fixtureFile.ts';

const tmps = [];
const tmp = (p = 'eval-test-') => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pinned = readFileSync(join(ROOT, 'evals', 'instances', 'multi-swe-bench-ts-v1.jsonl'), 'utf8');
const TEST_PATCH = 'diff --git a/t.spec.ts b/t.spec.ts\nnew file mode 100644\n--- /dev/null\n+++ b/t.spec.ts\n@@ -0,0 +1 @@\n+test(1)\n';

/** A toy upstream checkout with history and a tag, to prove the snapshot drops both. */
function toyUpstream() {
  const dir = tmp('eval-up-');
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '-A']); git(dir, ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-qm', 'one']);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-qam', 'two']);
  git(dir, ['tag', 'v1']);
  return dir;
}
const treeOf = (src) => ({ dest }) => { cpSync(src, dest, { recursive: true, filter: (p) => !p.includes(`${join(src, '.git')}`) }); };

describe('normalizers and prediction writers', () => {
  it('maps a Multi-SWE-bench row and hides the test patch from the brief', () => {
    const [{ set, task, row }] = loadInstances(pinned.split('\n')[0]);
    expect(set).toBe('multi-swe-bench');
    expect(task.id).toBe('vuejs/core:pr-8470');
    expect(task.baseSha).toBe(row.base.sha);
    expect(task.repoUrl).toBe('https://github.com/vuejs/core.git');
    expect(task.brief).toContain("defineEmits doesn't setup extended events");
    expect(task.brief).not.toContain(row.test_patch.slice(0, 80));
    expect(task.f2p.length).toBeGreaterThan(0);
    expect(task.p2p.length).toBeGreaterThan(0);
    expect(SETS[set].predictionLine(row, 'P')).toEqual({ org: 'vuejs', repo: 'core', number: 8470, fix_patch: 'P' });
  });
  it('maps a SWE-PolyBench row and writes instance_id/model_patch', () => {
    const row = { instance_id: 'mui__material-ui-1', repo: 'mui/material-ui', base_commit: 'abc', problem_statement: 'bug', patch: 'g', test_patch: TEST_PATCH, F2P: '["a"]', P2P: ['b'] };
    expect(detectSet(row)).toBe('swe-polybench');
    const [{ task }] = loadInstances(JSON.stringify(row));
    expect(task).toMatchObject({ id: 'mui__material-ui-1', baseSha: 'abc', brief: 'bug', f2p: ['a'], p2p: ['b'], repoUrl: 'https://github.com/mui/material-ui.git' });
    expect(SETS['swe-polybench'].predictionLine(row, 'P')).toEqual({ instance_id: 'mui__material-ui-1', model_patch: 'P' });
  });
  it('refuses mixed sets, duplicates and rows missing required fields', () => {
    const pb = { instance_id: 'x', repo: 'a/b', base_commit: 'c', problem_statement: 's', test_patch: '' };
    expect(() => loadInstances(`${pinned.split('\n')[0]}\n${JSON.stringify(pb)}`)).toThrow('mixes sets');
    expect(() => loadInstances(`${JSON.stringify(pb)}\n${JSON.stringify(pb)}`)).toThrow('duplicate');
    expect(() => loadInstances(JSON.stringify({ ...pb, problem_statement: '' }))).toThrow('problem_statement');
  });
  it('loads every pinned row', () => { expect(loadInstances(pinned)).toHaveLength(18); });
});

describe('snapshot', () => {
  it('is one commit with no tags or remote, and the agent patch includes untracked files', () => {
    const up = toyUpstream();
    const taskDir = tmp('eval-task-');
    const { repoDir, baseCommit } = buildSnapshot({ taskDir, repoUrl: 'x', baseSha: 'y', testPatch: TEST_PATCH, fetchTree: treeOf(up) });
    expect(git(repoDir, ['rev-list', '--all']).stdout.trim().split('\n')).toHaveLength(1);
    expect(git(repoDir, ['tag', '-l']).stdout.trim()).toBe('');
    expect(readFileSync(join(repoDir, 'a.txt'), 'utf8')).toBe('two\n');
    const wt = addWorktree({ taskDir });
    expect(git(repoDir, ['rev-list', '--all']).stdout.trim().split('\n')).toHaveLength(1);
    writeFileSync(join(wt, 'a.txt'), 'three\n');
    writeFileSync(join(wt, 'new.ts'), 'x\n');
    mkdirSync(join(wt, 'node_modules')); writeFileSync(join(wt, 'node_modules', 'dep.js'), 'x');
    const patch = worktreePatch(wt, baseCommit);
    expect(patchFiles(patch).sort()).toEqual(['a.txt', 'new.ts']);
  });
  it('refuses a forbidden path, extra history and an already-applied test patch', () => {
    for (const name of FORBIDDEN_TOP) {
      const up = toyUpstream();
      mkdirSync(join(up, name));
      writeFileSync(join(up, name, 'f'), 'x');
      git(up, ['add', '-A']); git(up, ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-qm', 'bad']);
      expect(() => buildSnapshot({ taskDir: tmp(), repoUrl: 'x', baseSha: 'y', testPatch: TEST_PATCH, fetchTree: treeOf(up) })).toThrow(`contains ${name}`);
    }
    const up = toyUpstream();
    expect(() => assertCleanSnapshot(up, TEST_PATCH)).toThrow('2 commits');
    const applied = toyUpstream();
    writeFileSync(join(applied, 't.spec.ts'), 'test(1)\n');
    expect(() => buildSnapshot({ taskDir: tmp(), repoUrl: 'x', baseSha: 'y', testPatch: TEST_PATCH, fetchTree: treeOf(applied) })).toThrow('already applied');
  });
  it('local-tree fetcher copies a tree', () => {
    const src = tmp(); writeFileSync(join(src, 'f'), 'x');
    const dest = tmp(); copyTreeFetcher(src)({ dest });
    expect(existsSync(join(dest, 'f'))).toBe(true);
  });
});

describe('install', () => {
  it('detects the lockfile and mounts the task at /task', () => {
    const has = (...names) => (p) => names.some((n) => p.endsWith(n));
    expect(installCommand('/w', has('pnpm-lock.yaml', 'package-lock.json'))).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(installCommand('/w', has('yarn.lock'))).toEqual(['yarn', 'install', '--frozen-lockfile']);
    expect(installCommand('/w', has('package-lock.json'))).toEqual(['npm', 'ci']);
    expect(installCommand('/w', has())).toBeNull();
    const args = installDockerArgs({ taskDir: '/t', image: 'img', argv: ['npm', 'ci'] });
    expect(args).toContain('/t:/task');
    expect(args.at(-1)).toContain('cd /task/wt && npm ci');
  });
});

describe('stats', () => {
  const a = (instanceId, variant, run, resolved, extra = {}) => ({ instanceId, variant, run, scoring: 'scored', end: 'terminal', blockedKind: null, resolved, ...extra });
  it('pass@k is the unbiased estimator', () => {
    expect(passAtK(3, 1, 1)).toBeCloseTo(1 / 3);
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passAtK(2, 0, 1)).toBe(0);
    expect(passAtK(2, 1, 3)).toBeNull();
  });
  it('excludes setup-failed from the rate, counts it by kind, and flags n<3', () => {
    const s = summarizeVariant([a('i1', 'v', 1, true), a('i2', 'v', 1, false), { ...a('i3', 'v', 1, false), scoring: 'excluded', end: 'blocked', blockedKind: 'setup-failed' }]);
    expect(s).toMatchObject({ scored: 2, resolved: 1, resolvedRate: 0.5, lowConfidence: true, runs: 1, spread: null });
    expect(s.ends).toEqual({ 'blocked:setup-failed': 1 });
    expect(LOW_CONFIDENCE_N).toBe(3);
  });
  it('keeps blocked-but-scored runs apart from test failure', () => {
    const s = summarizeVariant([a('i1', 'v', 1, false, { end: 'timeout' }), a('i2', 'v', 1, false)]);
    expect(s.resolved).toBe(0);
    expect(s.ends).toEqual({ timeout: 1 });
  });
  it('spread is the sd of the per-run rate', () => {
    const s = summarizeVariant([a('i1', 'v', 1, true), a('i1', 'v', 2, false)]);
    expect(s.spread).toBeCloseTo(Math.SQRT1_2 * 1);
  });
  it('deltas compare on shared scored instances only', () => {
    const d = pairwiseDeltas({ A: [a('i1', 'A', 1, false), a('i2', 'A', 1, true)], B: [a('i1', 'B', 1, true)] });
    expect(d).toEqual([{ a: 'A', b: 'B', sharedInstances: 1, delta: 1, lowConfidence: true }]);
  });
  it('per-resolved totals are pending when any attempt lacks the metric', () => {
    const m = (w) => ({ metrics: { wall: w } });
    expect(perResolved([a('i1', 'v', 1, true, m(10)), a('i2', 'v', 1, false, m(30))], (x) => x.metrics.wall)).toBe(40);
    expect(perResolved([a('i1', 'v', 1, true, m(10)), a('i2', 'v', 1, false, m(null))], (x) => x.metrics.wall)).toBeNull();
    expect(perResolved([a('i1', 'v', 1, false, m(10))], (x) => x.metrics.wall)).toBeNull();
  });
});

describe('variants and fixture', () => {
  it('has a closed key set and cannot carry gate-raising manifest keys', () => {
    expect(() => parseVariant('v', { approaches: {} })).toThrow('unknown key "approaches"');
    expect(() => parseVariant('v', { baselineReview: true })).toThrow('unknown key');
    expect(() => loadVariant('nope', '/nowhere')).toThrow('no /nowhere/nope.json');
    expect(loadVariant('default', '/nowhere')).toEqual({ name: 'default', provider: 'claude', gates: [] });
  });
  it('builds a fixture the real parser accepts, carrying the brief only', () => {
    const [{ task }] = loadInstances(pinned.split('\n')[0]);
    const fx = buildFixture({ task, variant: loadVariant('default', '/x') });
    const spec = parseFixtureFile(fx);
    expect(spec.tickets[0].description).toBe(task.brief);
    expect(JSON.stringify(fx)).not.toContain('fix_patch');
    expect(JSON.stringify(fx)).not.toContain(task.f2p[0]);
    expect(spec.tickets[0].repo.worktreePath).toBe('/task/wt');
  });
  it('steps end on ticketSettled', () => {
    expect(buildSteps({ waitMs: 5000 }).steps.at(-2)).toEqual({ type: 'wait', for: { ticketSettled: { key: 'EVAL-1' } }, timeoutMs: 5000 });
  });
});

function makeDb(path, { stage = 'ship', shipStatus = 'pending', blocked = null, tokens = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE tickets (id INTEGER PRIMARY KEY, stage_current TEXT);
    CREATE TABLE stages (ticket_id INT, stage_key TEXT, status TEXT, blocked_kind TEXT, blocked_reason TEXT);
    CREATE TABLE stage_runs (id INTEGER PRIMARY KEY); CREATE TABLE recovery_rounds (id INTEGER PRIMARY KEY);
    CREATE TABLE token_usage (id INTEGER PRIMARY KEY); CREATE TABLE process_runs (id INTEGER PRIMARY KEY);
    CREATE TABLE implementation_runs (id INTEGER PRIMARY KEY);`);
  db.prepare('INSERT INTO tickets VALUES (1, ?)').run(stage);
  for (const k of ['scope', 'impl', 'uat', 'review']) db.prepare('INSERT INTO stages VALUES (1, ?, ?, NULL, NULL)').run(k, 'passed');
  db.prepare('INSERT INTO stages VALUES (1, ?, ?, ?, ?)').run('ship', shipStatus, blocked, blocked ? 'because' : null);
  db.exec('INSERT INTO stage_runs VALUES (1); INSERT INTO process_runs VALUES (1);');
  if (tokens) db.exec('INSERT INTO token_usage VALUES (1);');
  db.close();
}
const STATS = {
  agentActiveTime: { processRunHours: 0.5, implementationRunHours: 0.25 },
  firstPass: { overall: { rate: 0.75 } }, rework: { rounds: 2 }, findings: { review: { total: 4 } },
  tokens: { reportedTokens: 100, estimatedTokens: 20, byCallSite: [{ callSite: 'impl', calls: 1, reportedTokens: 100, estimatedTokens: 20 }] },
};

describe('end state and metrics', () => {
  it('classifies the terminal point, a block, and a timeout apart', async () => {
    const d = tmp();
    makeDb(join(d, 'a.db'));
    expect((await readRunState(join(d, 'a.db'))).end).toMatchObject({ outcome: 'terminal', stage: 'ship' });
    makeDb(join(d, 'b.db'), { stage: 'ship', shipStatus: 'running', blocked: 'awaiting-merge' });
    expect((await readRunState(join(d, 'b.db'))).end).toMatchObject({ outcome: 'blocked', blockedKind: 'awaiting-merge', reason: 'because' });
    makeDb(join(d, 'c.db'), { stage: 'impl', shipStatus: 'pending' });
    expect((await readRunState(join(d, 'c.db'), { timedOut: true })).end.outcome).toBe('timeout');
  });
  it('reports missing sources as pending (null), never 0', async () => {
    const d = tmp();
    makeDb(join(d, 'a.db'), { tokens: false });
    const st = await readRunState(join(d, 'a.db'));
    const m = attemptMetrics({ stats: STATS, ...st, wallMs: 5000 });
    expect(m.tokens).toBeNull();
    expect(m.costUsd).toBeNull();
    expect(m).toMatchObject({ wallSeconds: 5, agentActiveSeconds: 2700, reworkRounds: 2, firstPassRate: 0.75, reviewFindings: 4 });
    const none = attemptMetrics({ stats: STATS, sources: { stage_runs: 0, recovery_rounds: 0, token_usage: 0, process_runs: 0, implementation_runs: 0 }, stages: [], wallMs: null });
    expect(none).toMatchObject({ reworkRounds: null, firstPassRate: null, agentActiveSeconds: null, reviewFindings: null, wallSeconds: null });
  });
});

describe('report', () => {
  it('records set version, cores, low confidence and pending values', () => {
    const at = (i, resolved) => ({ instanceId: i, variant: 'default', run: 1, scoring: 'scored', end: 'terminal', blockedKind: null, stage: 'ship', reason: null, resolved, metrics: { wallSeconds: 60, agentActiveSeconds: null, tokens: null } });
    const md = renderReport({
      meta: { setName: 'multi-swe-bench', setVersion: 'multi-swe-bench-ts-v1', cores: [{ core: 'claude', version: '2.1.0' }], variants: ['default'], runs: 1, startedAt: 't', excluded: ['x/y:pr-1'] },
      attempts: [at('i1', true), { ...at('i2', false), scoring: 'excluded', end: 'blocked', blockedKind: 'setup-failed', stage: null, reason: 'npm ci failed' }],
    });
    expect(md).toContain('multi-swe-bench-ts-v1');
    expect(md).toContain('claude 2.1.0');
    expect(md).toContain('LOW (n<3)');
    expect(md).toContain('blocked:setup-failed');
    expect(md).toContain('x/y:pr-1');
    expect(md).toMatch(/\| pending \|/);
  });
});

describe('args and budget', () => {
  it('parses flags, defaults a variant, and refuses bad input', () => {
    expect(parseArgs(['--', '--instances', 'f', '--runs', '3'])).toMatchObject({ instances: 'f', variants: ['default'], runs: 3 });
    expect(parseArgs(['--instances', 'f', '--fake-core']).noScore).toBe(true);
    expect(() => parseArgs([])).toThrow('--instances');
    expect(() => parseArgs(['--instances', 'f', '--runs', '0'])).toThrow('--runs');
    expect(() => parseArgs(['--instances', 'f', '--variant', 'a', '--variant', 'a'])).toThrow('twice');
  });
  it('shrinks an attempt budget to what the whole run has left', () => {
    expect(attemptBudgetMs({ perInstanceMin: 45, budgetMin: 480, elapsedMs: 0 })).toBe(45 * 60_000);
    expect(attemptBudgetMs({ perInstanceMin: 45, budgetMin: 60, elapsedMs: 50 * 60_000 })).toBe(10 * 60_000);
  });
});

describe('adapter end to end (fake executors)', () => {
  it('instance in, predictions.jsonl out, report with merged results', async () => {
    const up = toyUpstream();
    const inst = tmp();
    const row = { org: 'toy', repo: 'repo', number: 1, base: { sha: 'abc' }, resolved_issues: [{ title: 'T', body: 'B' }], fix_patch: 'GOLD', test_patch: TEST_PATCH, f2p_tests: { a: {} }, p2p_tests: { b: {} } };
    writeFileSync(join(inst, 'toy-v1.jsonl'), `${JSON.stringify(row)}\n`);
    const out = join(ROOT, 'eval-results', `test-${process.pid}`);
    tmps.push(out);
    const seen = { fixture: null };
    const exec = {
      install: () => ({ ok: true, detail: '' }),
      uat: async ({ args }) => {
        const at = (flag) => args[args.indexOf(flag) + 1];
        seen.fixture = JSON.parse(readFileSync(join(ROOT, at('--fixture-file')), 'utf8'));
        writeFileSync(join(at('--eval-task'), 'wt', 'fix.ts'), 'export const fixed = true;\n');
        makeDb(join(ROOT, at('--db-out')));
        writeFileSync(join(ROOT, at('--eval-result')), JSON.stringify({ core: 'claude', version: '9.9.9' }));
        return { timedOut: false, code: 0 };
      },
      stats: () => STATS,
      score: ({ rows, predictionsPath }) => {
        const lines = readFileSync(predictionsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(Object.keys(lines[0]).sort()).toEqual(['fix_patch', 'number', 'org', 'repo']);
        expect(lines[0].fix_patch).toContain('fix.ts');
        expect(rows).toHaveLength(1);
        return new Map([['toy/repo:pr-1', 'resolved']]);
      },
    };
    // Bypass the network fetch: snapshot the toy tree instead.
    const { runAttempt, main: m } = await import('./run.mjs');
    void m;
    const o = parseArgs(['--instances', join(inst, 'toy-v1.jsonl'), '--python', process.execPath, '--out', out]);
    const item = loadInstances(readFileSync(join(inst, 'toy-v1.jsonl'), 'utf8'))[0];
    const rec = await runAttempt({ item, variant: loadVariant('default', '/x'), run: 1, o, attemptDir: join(out, 'attempts', '001'), exec, elapsedMs: 0, fetchTree: treeOf(up) });
    expect(rec).toMatchObject({ scoring: 'scored', end: 'terminal', stage: 'ship' });
    expect(rec.patch).toContain('fix.ts');
    expect(rec.metrics.reworkRounds).toBe(2);
    expect(seen.fixture.tickets[0].description).toBe('T\n\nB');
    expect(existsSync(join(out, 'attempts', '001', 'patch.diff'))).toBe(true);
  });
  it('records a failed install as blocked(setup-failed) and writes no prediction', async () => {
    const up = toyUpstream();
    writeFileSync(join(up, 'package-lock.json'), '{}');
    git(up, ['add', '-A']); git(up, ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '-qm', 'lock']);
    const row = { org: 'toy', repo: 'repo', number: 2, base: { sha: 'abc' }, resolved_issues: [{ title: 'T', body: 'B' }], fix_patch: 'G', test_patch: TEST_PATCH, f2p_tests: {}, p2p_tests: {} };
    const out = join(ROOT, 'eval-results', `test-${process.pid}-b`);
    tmps.push(out);
    const o = parseArgs(['--instances', 'x', '--no-score']);
    const exec = { install: () => ({ ok: false, detail: 'ENOTFOUND github.com' }), uat: () => { throw new Error('must not run'); } };
    const { runAttempt } = await import('./run.mjs');
    const item = { set: 'multi-swe-bench', row, task: SETS['multi-swe-bench'].normalize(row) };
    const rec = await runAttempt({ item, variant: loadVariant('default', '/x'), run: 1, o, attemptDir: join(out, 'a'), exec, elapsedMs: 0, fetchTree: treeOf(up) });
    expect(rec).toMatchObject({ scoring: 'excluded', end: 'blocked', blockedKind: 'setup-failed', patch: null });
    expect(rec.reason).toContain('ENOTFOUND');
  });
});
