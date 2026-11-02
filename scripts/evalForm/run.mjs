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

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CASES = join(ROOT, 'evals/form/improve-cases.jsonl');
export const DEFAULT_INSTANCES = join(ROOT, 'evals/instances/multi-swe-bench-ts-v1.jsonl');
export const DEFAULT_RUNS = 3;
const PASSES = ['improve', 'intent'];
const SOURCES = ['raw', 'improved'];
const PROVIDERS = ['claude', 'codex'];

export function parseArgs(argv) {
  const o = { pass: 'improve', prompts: [], cases: [], only: null, runs: DEFAULT_RUNS, provider: 'claude', model: null, judgeModel: null, sources: [], improvePrompt: 'builtin', instances: DEFAULT_INSTANCES };
  const need = (i) => { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pass') o.pass = need(i);
    else if (a === '--prompt') o.prompts.push(need(i));
    else if (a === '--cases') o.cases.push(need(i));
    else if (a === '--only') o.only = need(i).split(',').filter(Boolean);
    else if (a === '--runs') o.runs = Number(need(i));
    else if (a === '--provider') o.provider = need(i);
    else if (a === '--source') o.sources.push(need(i));
    else if (a === '--improve-prompt') o.improvePrompt = need(i);
    else if (a === '--instances') o.instances = need(i);
    else if (a === '--model') o.model = need(i);
    else if (a === '--judge-model') o.judgeModel = need(i);
    else throw new Error(`unknown flag ${a}`);
    i++;
  }
  if (!PASSES.includes(o.pass)) throw new Error(`--pass must be one of ${PASSES.join('|')}`);
  if (o.sources.some((x) => !SOURCES.includes(x))) throw new Error(`--source must be ${SOURCES.join('|')}`);
  if (!PROVIDERS.includes(o.provider)) throw new Error(`--provider must be one of ${PROVIDERS.join('|')}`);
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
  const adapter = resolveAdapter(opts.provider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, pass: 'intent', model: opts.model, judgeModel: opts.judgeModel, provider: opts.provider, runs: opts.runs, sources: modes.map((m) => m.name) };
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

export async function main(argv) {
  const opts = parseArgs(argv);
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
  const adapter = resolveAdapter(opts.provider);
  const startedAt = new Date().toISOString();
  const meta = { startedAt, model: opts.model, judgeModel: opts.judgeModel, provider: opts.provider, runs: opts.runs, sources: sources.map((s) => s.name) };
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
