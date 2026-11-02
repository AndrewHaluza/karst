// npm run eval:form -- --pass improve --prompt builtin --prompt <file.md> --model X --judge-model Y [--runs 3]
// Runs the REAL improveDescription (via tsx) per prompt source, scores it, writes eval-results/form-<ts>/.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './checks.mjs';
import { judgeOutput } from './judge.mjs';
import { loadCases, loadPromptSource } from './inputs.mjs';
import { renderReport } from './report.mjs';
import { renderIntentReport } from './intentReport.mjs';
import { caseItem, instanceItem, runIntentEval } from './intentRun.mjs';
import { loadInstances } from '../eval/instances.mjs';
import { readFileSync } from 'node:fs';
import { renderDraftReport } from './draftReport.mjs';
import { runDraftEval } from './draftRun.mjs';
import { gitRunner } from './draftChecks.mjs';
import { parseJsonl } from './inputs.mjs';
import { DEFAULT_JUDGE_EFFORT, DEFAULT_SEED, buildJobs, collectResultFiles, loadCaseMap, loadInstanceMap, pool, runRejudge } from './rejudge.mjs';
import { renderRejudgeReport } from './rejudgeReport.mjs';
import { renderPlanRatings, renderPlanReport } from './planReport.mjs';
import { makeWork, runPlanEval } from './planRun.mjs';
import { buildPlanKickoff, buildPlanManifest } from './planPrompt.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CASES = join(ROOT, 'evals/form/improve-cases.jsonl');
export const DEFAULT_INSTANCES = join(ROOT, 'evals/instances/multi-swe-bench-ts-v1.jsonl');
export const DEFAULT_RUNS = 3;
export const DEFAULT_DRAFTS = join(ROOT, 'evals/form/local/drafts.jsonl');
export const OWN_CASES = join(ROOT, 'evals/form/local/own-tickets.jsonl');
export const PLAN_REPOS = join(ROOT, 'evals/form/local/repos');
export const PLAN_RATINGS = join(ROOT, 'evals/form/PLANNER-MODEL-RATINGS.md');
const PASSES = ['improve', 'intent', 'draft', 'plan'];
const SOURCES = ['raw', 'improved'];
const PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'];

export function parseArgs(argv) {
  const o = { pass: 'improve', prompts: [], cases: [], only: null, runs: DEFAULT_RUNS, provider: 'claude', model: null, judgeModel: null, effort: null, sources: [], improvePrompt: 'builtin', instances: DEFAULT_INSTANCES, drafts: DEFAULT_DRAFTS, repos: {}, rejudge: [], judgeModels: [], judgeProviders: [], judgeEffort: DEFAULT_JUDGE_EFFORT, seed: DEFAULT_SEED, maxCalls: Infinity, dryRun: false, models: [], timeoutMin: 10, maxDrafts: 3, publish: false };
  const need = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--publish') { o.publish = true; continue; }
    if (a === '--pass') o.pass = need(i);
    else if (a === '--prompt') o.prompts.push(need(i));
    else if (a === '--cases') o.cases.push(need(i));
    else if (a === '--only') o.only = need(i).split(',').filter(Boolean);
    else if (a === '--runs') o.runs = Number(need(i));
    else if (a === '--provider') o.provider = need(i);
    else if (a === '--source') o.sources.push(need(i));
    else if (a === '--improve-prompt') o.improvePrompt = need(i);
    else if (a === '--instances') o.instances = need(i);
    else if (a === '--drafts') o.drafts = need(i);
    else if (a === '--repo') { const [n, ...p] = need(i).split('='); if (!n || p.length === 0) throw new Error('--repo needs <name>=<path>'); o.repos[n] = p.join('='); }
    else if (a === '--db') o.db = need(i);
    else if (a === '--model') o.model = need(i);
    else if (a === '--rejudge') o.rejudge.push(need(i));
    else if (a === '--judge-model') { o.judgeModel = need(i); o.judgeModels.push(o.judgeModel); }
    else if (a === '--judge-provider') o.judgeProviders.push(need(i));
    else if (a === '--judge-effort') o.judgeEffort = need(i);
    else if (a === '--seed') o.seed = Number(need(i));
    else if (a === '--max-calls') o.maxCalls = Number(need(i));
    else if (a === '--effort') o.effort = need(i);
    else if (a === '--models') o.models = need(i).split(',').filter(Boolean);
    else if (a === '--timeout-min') o.timeoutMin = Number(need(i));
    else if (a === '--max-drafts') o.maxDrafts = Number(need(i));
    else throw new Error(`unknown flag ${a}`);
    i++;
  }
  if (o.rejudge.length) return validateRejudge(o);
  if (o.dryRun) throw new Error('--dry-run needs --rejudge');
  if (!PASSES.includes(o.pass)) throw new Error(`--pass must be one of ${PASSES.join('|')}`);
  if (o.sources.some((x) => !SOURCES.includes(x))) throw new Error(`--source must be ${SOURCES.join('|')}`);
  if (!PROVIDERS.includes(o.provider)) throw new Error(`--provider must be one of ${PROVIDERS.join('|')}`);
  if (o.pass === 'plan') return validatePlan(o);
  if (o.pass === 'draft') {
    if (!o.judgeModel) throw new Error('--judge-model is required');
    if (!o.db) throw new Error('--db <karst.db> is required for --pass draft');
    return o;
  }
  if (!o.model) throw new Error('--model is required');
  if (!o.judgeModel) throw new Error('--judge-model is required');
  if (o.judgeModel === o.model) throw new Error('--judge-model must differ from --model');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs must be a positive integer');
  if (o.pass === 'intent') {
    if (o.sources.length === 0) o.sources = ['raw'];
    return o;
  }
  if (o.prompts.length === 0) o.prompts = ['builtin'];
  if (o.cases.length === 0) o.cases = [DEFAULT_CASES];
  return o;
}

function validatePlan(o) {
  if (o.models.length === 0) throw new Error('--models is required for --pass plan');
  if (!o.judgeModel) throw new Error('--judge-model is required');
  if (o.models.includes(o.judgeModel)) throw new Error('--judge-model must differ from every --models entry');
  if (!(o.timeoutMin > 0)) throw new Error('--timeout-min must be a positive number');
  if (!Number.isInteger(o.maxDrafts) || o.maxDrafts < 1) throw new Error('--max-drafts must be a positive integer');
  return o;
}

function validateRejudge(o) {
  if (o.judgeModels.length === 0) throw new Error('--judge-model is required');
  if (new Set(o.judgeModels).size !== o.judgeModels.length) throw new Error('--judge-model values must differ');
  if (o.judgeProviders.some((p) => !PROVIDERS.includes(p))) throw new Error(`--judge-provider must be one of ${PROVIDERS.join('|')}`);
  if (!Number.isInteger(o.seed)) throw new Error('--seed must be an integer');
  if (o.maxCalls !== Infinity && (!Number.isInteger(o.maxCalls) || o.maxCalls < 1)) throw new Error('--max-calls must be a positive integer');
  if (o.cases.length === 0) o.cases = [DEFAULT_CASES, OWN_CASES];
  return o;
}

/** Wrap an adapter so the usage of its last headless result can be read (improveDescription returns text only). */
export function recordUsage(adapter) {
  const rec = { usage: undefined };
  return {
    rec,
    adapter: new Proxy(adapter, {
      get(t, p) {
        if (p !== 'runHeadless') return Reflect.get(t, p);
        return async (opts) => { const r = await t.runHeadless(opts); rec.usage = r.usage; return r; };
      },
    }),
  };
}

/** Core loop, strictly sequential. Injected seams keep it testable with fake adapters. */
export async function runEval({ opts, cases, sources, improve, adapter, judgeAdapter, now = () => Date.now(), makeEmptyDir, onProgress = () => {} }) {
  const attempts = [];
  const emptyDir = makeEmptyDir();
  try {
    for (const source of sources) {
      for (const c of cases) {
        for (let run = 1; run <= opts.runs; run++) {
          const cwd = c.id.startsWith('own-') ? ROOT : emptyDir;
          const { adapter: wrapped, rec } = recordUsage(adapter);
          const a = { caseId: c.id, source: source.name, run };
          const t0 = now();
          try {
            a.output = await improve(wrapped, {
              instructions: source.body ?? '', description: c.input, title: c.title, ticketType: c.type, cwd, model: opts.model,
              ...(opts.effort ? { effort: opts.effort } : {}),
            });
            a.seconds = (now() - t0) / 1000;
            a.usage = rec.usage;
            a.checks = runChecks({ output: a.output, input: c.input, type: c.type, tokens: c.expect.verbatim, expect: c.expect });
            a.judge = await judgeOutput(judgeAdapter, { source: c.input, output: a.output, model: opts.judgeModel, cwd: emptyDir });
          } catch (e) {
            a.error = e instanceof Error ? e.message : String(e);
          }
          attempts.push(a);
          onProgress(a);
        }
      }
    }
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
  return attempts;
}

export function writeResults(dir, { meta, cases, attempts }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderReport({ meta, cases, attempts }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, cases, attempts }, null, 2));
}

/** Source modes = report columns: `raw`, and `improved:<prompt name>`. */
export function intentModes(opts, read) {
  return opts.sources.map((s) => (s === 'raw'
    ? { name: 'raw', kind: 'raw' }
    : (({ name, body }) => ({ name: `improved:${name}`, kind: 'improved', body }))(loadPromptSource(opts.improvePrompt, read))));
}

async function mainIntent(opts) {
  const [{ improveDescription }, { generateIntent }, { resolveAdapter }] = await Promise.all([
    import('../../src/workflow/classify/improve.ts'), import('../../src/workflow/classify/intent.ts'), import('../../src/agent/registry.ts'),
  ]);
  if (!existsSync(opts.instances)) throw new Error(`instances file not found: ${opts.instances}`);
  let items = [
    ...loadInstances(readFileSync(opts.instances, 'utf8')).map(instanceItem),
    ...opts.cases.flatMap((p) => { if (!existsSync(p)) throw new Error(`cases file not found: ${p}`); return loadCases(p).map(caseItem); }),
  ];
  if (opts.only) items = items.filter((c) => opts.only.includes(c.id));
  if (items.length === 0) throw new Error('no instances selected');
  const modes = intentModes(opts);
  const adapter = resolveAdapter(opts.provider === 'opencode' ? 'opencode2' : opts.provider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, pass: 'intent', model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}), judgeModel: opts.judgeModel, provider: opts.provider, runs: opts.runs, sources: modes.map((m) => m.name) };
  const attempts = await runIntentEval({
    opts, items, modes, improve: improveDescription, intent: generateIntent, adapter, judgeAdapter: adapter,
    makeEmptyDir: () => mkdtempSync(join(tmpdir(), 'eval-form-')),
    onProgress: (a) => console.error(`${a.source} ${a.caseId} run ${a.run}: ${a.error ? 'ERROR ' + a.error : 'done'}`),
  });
  const dir = join(ROOT, 'eval-results', `form-${startedAt.replace(/[:.]/g, '-')}`);
  const slim = items.map(({ testPatch, ...rest }) => rest); // test_patch stays out of results
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderIntentReport({ meta, items: slim, attempts }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, items: slim, attempts }, null, 2));
  console.log(`report: ${join(dir, 'report.md')}`);
}

async function mainDraft(opts) {
  const [{ resolveAdapter }, { openReadonlyStore }, { collectDraftOutcomes }] = await Promise.all([
    import('../../src/agent/registry.ts'), import('../../src/cli/readonlyStore.ts'), import('../../src/store/metrics/planning.ts'),
  ]);
  if (!existsSync(opts.drafts)) throw new Error(`drafts file not found: ${opts.drafts} (run eval:form:export -- --pass draft first)`);
  let rows = parseJsonl(readFileSync(opts.drafts, 'utf8'), opts.drafts);
  if (opts.only) rows = rows.filter((r) => opts.only.includes(String(r.id)));
  if (rows.length === 0) throw new Error('no drafts selected');
  const adapter = resolveAdapter(opts.provider === 'opencode' ? 'opencode2' : opts.provider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, pass: 'draft', judgeModel: opts.judgeModel, provider: opts.provider };
  const cwd = mkdtempSync(join(tmpdir(), 'eval-form-'));
  const store = openReadonlyStore(opts.db);
  try {
    const results = await runDraftEval({
      opts, rows, judgeAdapter: adapter, cwd,
      gitFor: (repo) => (opts.repos[repo] ? gitRunner(opts.repos[repo]) : null),
      onProgress: (r) => console.error(`D${r.id}: ${r.error ? 'ERROR ' + r.error : r.unavailable ? `unavailable(${r.unavailable})` : 'done'}`),
    });
    const outcomes = collectDraftOutcomes(store, {});
    const dir = join(ROOT, 'eval-results', `form-${startedAt.replace(/[:.]/g, '-')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), renderDraftReport({ meta, results, outcomes }));
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, results, outcomes: Object.fromEntries(outcomes) }, null, 2));
    console.log(`report: ${join(dir, 'report.md')}`);
  } finally { store.close(); rmSync(cwd, { recursive: true, force: true }); }
}

/** Instance row -> bench item. The gold (`fixPatch`, `testPatch`) stays here, never in the prompt. */
export function planItem({ row, task }) {
  const [title, ...rest] = task.brief.split('\n');
  return { id: task.id, dir: `${row.org}__${row.repo}-${row.number}`, repo: row.repo, title, body: rest.join('\n').trim(), baseSha: task.baseSha, fixPatch: row.fix_patch ?? '', testPatch: task.testPatch, f2p: task.f2p };
}

async function mainPlan(opts) {
  const [{ resolveAdapter }, preamble, { validateProposal }] = await Promise.all([
    import('../../src/agent/registry.ts'), import('../../src/planning/preamble.ts'), import('../../src/planning/proposal.ts'),
  ]);
  if (!existsSync(opts.instances)) throw new Error(`instances file not found: ${opts.instances}`);
  const pinned = new Set(readFileSync(join(PLAN_REPOS, 'pins.txt'), 'utf8').split('\n').map((l) => l.split(' ')[0]).filter(Boolean));
  let items = loadInstances(readFileSync(opts.instances, 'utf8')).map(planItem).filter((i) => pinned.has(i.dir));
  if (opts.only) items = items.filter((c) => opts.only.includes(c.id) || opts.only.includes(c.dir));
  if (items.length === 0) throw new Error('no instances selected');
  const adapter = resolveAdapter(opts.provider === 'opencode' ? 'opencode2' : opts.provider);
  const judgeProvider = opts.judgeProviders[0] ?? 'claude';
  if (!PROVIDERS.includes(judgeProvider)) throw new Error(`--judge-provider must be one of ${PROVIDERS.join('|')}`);
  const judgeAdapter = resolveAdapter(judgeProvider === 'opencode' ? 'opencode2' : judgeProvider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, pass: 'plan', models: opts.models, judgeModel: opts.judgeModel, provider: opts.provider, judgeProvider, judgeEffort: opts.judgeEffort };
  const cwd = mkdtempSync(join(tmpdir(), 'eval-form-'));
  try {
    const results = await runPlanEval({
      opts, items, models: opts.models, adapter, judgeAdapter, validate: validateProposal, cwd,
      cliEntry: join(ROOT, 'dist/cli/main.js'),
      makeWork: (item) => makeWork(item, PLAN_REPOS),
      buildPrompt: (item, w) => ({
        instructions: preamble.planningInstructions({ sessionId: 1, title: item.title, manifest: buildPlanManifest(item.repo, w.checkout) }),
        kickoff: preamble.planningKickoff(buildPlanKickoff(item)),
      }),
      onProgress: (r) => console.error(`${r.caseId} ${r.model}: ${r.status}${r.error ? ' ' + r.error : ''}`),
    });
    const dir = join(ROOT, 'eval-results', `plan-${startedAt.replace(/[:.]/g, '-')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), renderPlanReport({ meta, results }));
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
    if (opts.publish) writeFileSync(PLAN_RATINGS, renderPlanRatings({ meta, results }));
    console.log(`report: ${join(dir, 'report.md')}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

async function mainRejudge(opts) {
  const results = collectResultFiles(opts.rejudge);
  const entries = pool(results, { seed: opts.seed, cases: loadCaseMap(opts.cases), instances: loadInstanceMap(opts.instances) });
  const jobs = buildJobs(entries, opts.judgeModels, opts.seed);
  if (opts.dryRun) { console.log(`judge calls: ${jobs.length} (${jobs.length / opts.judgeModels.length} attempts x ${opts.judgeModels.length} judge(s))`); return; }
  const { resolveAdapter } = await import('../../src/agent/registry.ts');
  const adapters = opts.judgeModels.map((_, j) => { const p = opts.judgeProviders[j] ?? opts.judgeProviders[0] ?? 'claude'; return resolveAdapter(p === 'opencode' ? 'opencode2' : p); });
  const { stopped } = await runRejudge({ jobs, judges: opts.judgeModels, adapters, effort: opts.judgeEffort, maxCalls: opts.maxCalls, onProgress: (d, n) => console.error(`judged ${d}/${n}`) });
  const dir = join(ROOT, 'eval-results', `rejudge-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderRejudgeReport({ judges: opts.judgeModels, entries, stopped, maxCalls: opts.maxCalls, files: results.length, seed: opts.seed, effort: opts.judgeEffort }));
  console.log(`report: ${join(dir, 'report.md')}`);
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.pass === 'draft') return mainDraft(opts);
  if (opts.pass === 'plan') return mainPlan(opts);
  if (opts.rejudge.length) return mainRejudge(opts);
  if (opts.pass === 'intent') return mainIntent(opts);
  const [{ improveDescription }, { resolveAdapter }] = await Promise.all([
    import('../../src/workflow/classify/improve.ts'), import('../../src/agent/registry.ts'),
  ]);
  const sources = opts.prompts.map((p) => loadPromptSource(p));
  let cases = opts.cases.flatMap((p) => {
    if (!existsSync(p)) throw new Error(`cases file not found: ${p}`);
    return loadCases(p);
  });
  if (opts.only) cases = cases.filter((c) => opts.only.includes(c.id));
  if (cases.length === 0) throw new Error('no cases selected');
  const adapter = resolveAdapter(opts.provider === 'opencode' ? 'opencode2' : opts.provider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}), judgeModel: opts.judgeModel, provider: opts.provider, runs: opts.runs, sources: sources.map((s) => s.name) };
  const attempts = await runEval({
    opts, cases, sources, improve: improveDescription, adapter, judgeAdapter: adapter,
    makeEmptyDir: () => mkdtempSync(join(tmpdir(), 'eval-form-')),
    onProgress: (a) => console.error(`${a.source} ${a.caseId} run ${a.run}: ${a.error ? 'ERROR ' + a.error : 'done'}`),
  });
  const dir = join(ROOT, 'eval-results', `form-${startedAt.replace(/[:.]/g, '-')}`);
  writeResults(dir, { meta, cases, attempts });
  console.log(`report: ${join(dir, 'report.md')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
