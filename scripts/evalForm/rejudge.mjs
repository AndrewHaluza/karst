// eval:form --rejudge: re-score saved improve/intent attempts with ONE shared blind judge. No producer call is made.
// Blindness: the judge prompt comes from buildJudgePrompt / buildIntentJudgePrompt (rubric + source + output only).
// The attempt -> producer mapping lives here, never in a prompt.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './checks.mjs';
import { judgeOutput } from './judge.mjs';
import { judgeIntent, judgeIssueScope } from './intentJudge.mjs';
import { checkCharter, hunkForTest } from './intentChecks.mjs';
import { loadCases, prng } from './inputs.mjs';
import { loadInstances } from '../eval/instances.mjs';

export const CHECKER_VERSION = 'checks.mjs + intentChecks.mjs @ current checkout';
export const DEFAULT_JUDGE_EFFORT = 'low';
export const DEFAULT_SEED = 1;
export const LOW_N = 10;

const VENDORS = [
  ['anthropic', /claude|opus|sonnet|haiku/i], ['google', /gemini/i], ['openai', /gpt|codex|\bo\d\b/i],
  ['deepseek', /deepseek/i], ['xiaomi', /mimo/i],
];
export const vendorOf = (model) => VENDORS.find(([, re]) => re.test(String(model ?? '')))?.[0] ?? null;

const SELF_ID = [
  /\b(claude|anthropic|opus|sonnet|haiku|gemini|google deepmind|gpt-?\d*|openai|codex|deepseek|mimo|opencode|antigravity|llama|qwen|mistral)\b/gi,
  /\bas an ai\b/gi, /\bas a language model\b/gi, /\bi(?:'m| am) an? (?:ai|assistant|llm)\b/gi,
];

/** Self-identifying text in `text` that the source does not contain. Deterministic; the output is never edited. */
export function scanSelfIdentity(text, source) {
  const src = String(source ?? '').toLowerCase();
  const hits = new Set();
  for (const re of SELF_ID) for (const m of String(text ?? '').matchAll(re)) if (!src.includes(m[0].toLowerCase())) hits.add(m[0].toLowerCase());
  return [...hits];
}

/** Files and directories -> parsed results. A directory contributes its results.json (or its children's). */
export function collectResultFiles(paths) {
  const files = [];
  const add = (p) => {
    if (!existsSync(p)) throw new Error(`rejudge path not found: ${p}`);
    if (!statSync(p).isDirectory()) { files.push(p); return; }
    if (existsSync(join(p, 'results.json'))) { files.push(join(p, 'results.json')); return; }
    for (const e of readdirSync(p).sort()) { const c = join(p, e); if (statSync(c).isDirectory()) add(c); }
  };
  paths.forEach(add);
  if (files.length === 0) throw new Error('no results.json found');
  return files.map((f) => {
    const r = JSON.parse(readFileSync(f, 'utf8'));
    if (!r?.meta || !Array.isArray(r.attempts)) throw new Error(`${f}: not a results.json`);
    return r;
  });
}

export const producerOf = (meta) => ({ model: meta.model, provider: meta.provider, effort: meta.effort ?? null, oldJudge: meta.judgeModel ?? null });
export const producerLabel = (p) => `${p.model} (${p.provider}${p.effort ? `, ${p.effort}` : ''})`;
const opaqueId = (parts, seed) => createHash('sha256').update(`${seed}\0${parts.join('\0')}`).digest('hex').slice(0, 16);

/** Cases by id from case files (improve): first file wins; embedded results cases are the fallback. */
export function loadCaseMap(files) {
  const m = new Map();
  for (const f of files) if (existsSync(f)) for (const c of loadCases(f)) if (!m.has(c.id)) m.set(c.id, c);
  return m;
}

export function loadInstanceMap(file) {
  const m = new Map();
  if (file && existsSync(file)) for (const { task } of loadInstances(readFileSync(file, 'utf8'))) m.set(task.id, task);
  return m;
}

/** One pooled attempt: producer mapping kept here, the judge never sees it. */
function toEntry(res, a, ctx) {
  const pass = res.meta.pass ?? 'improve';
  const producer = producerOf(res.meta);
  const base = { pass, producer, caseId: a.caseId, source: a.source, run: a.run, oldJudge: a.judge ?? null, id: opaqueId([pass, JSON.stringify(producer), a.caseId, a.source, a.run, String(a.output ?? a.charter ?? '').length], ctx.seed) };
  const text = pass === 'intent' ? a.charter : a.output;
  if (a.error || typeof text !== 'string') return { ...base, skip: 'no-output' };
  if (pass === 'intent') {
    const inst = ctx.instances.get(a.caseId);
    const emb = (res.items ?? []).find((i) => i.id === a.caseId);
    const brief = inst?.brief ?? emb?.brief;
    if (!brief) return { ...base, skip: 'no-input' };
    const f2p = inst?.f2p ?? emb?.f2p ?? [];
    const testPatch = inst?.testPatch ?? '';
    const tests = f2p.map((test) => ({ test, hunk: hunkForTest(testPatch, test) }));
    const checks = checkCharter({ result: { text, degraded: false }, calls: a.checks?.outcome === 'nudged' ? 2 : 1, f2p });
    return { ...base, text, source_text: brief, tests, checks, selfId: scanSelfIdentity(text, brief) };
  }
  const c = ctx.cases.get(a.caseId) ?? (res.cases ?? []).find((x) => x.id === a.caseId);
  if (!c?.input) return { ...base, skip: 'no-input' };
  const checks = runChecks({ output: text, input: c.input, type: c.type, tokens: c.expect?.verbatim ?? [], expect: c.expect });
  return { ...base, text, source_text: c.input, checks, selfId: scanSelfIdentity(text, c.input) };
}

export function pool(results, ctx) {
  return results.flatMap((res) => res.attempts.map((a) => toEntry(res, a, ctx)));
}

/** Judge-call jobs (entry x judge) in a seeded shuffled order, so calls are not grouped by producer. */
export function buildJobs(entries, judges, seed) {
  const jobs = entries.filter((e) => !e.skip).flatMap((entry) => judges.map((_, j) => ({ entry, j })));
  const rnd = prng(seed);
  for (let i = jobs.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [jobs[i], jobs[k]] = [jobs[k], jobs[i]]; }
  return jobs;
}

const scopeKey = ({ entry, j }) => `${j}\0${entry.caseId}`;
const needsScope = ({ entry }) => entry.pass === 'intent' && entry.tests.length > 0;

/** Calls that the jobs make: one per job, and one issue-scope call per intent case and judge. */
export function countJudgeCalls(jobs) {
  const scopes = new Set(jobs.filter(needsScope).map(scopeKey)).size;
  return { attempts: jobs.length, scopes, total: jobs.length + scopes };
}

/**
 * Run the jobs sequentially, each in a fresh empty cwd. Returns {done, stopped}. Results land on entry.judged[j].
 * One judge decides the issue scope of a case once, so all charters of that case share one denominator.
 */
export async function runRejudge({ jobs, judges, adapters, effort = DEFAULT_JUDGE_EFFORT, maxCalls = Infinity, makeEmptyDir = () => mkdtempSync(join(tmpdir(), 'eval-rejudge-')), onProgress = () => {} }) {
  const scopes = new Map();
  let done = 0;
  let calls = 0;
  for (const job of jobs) {
    const { entry, j } = job;
    const scopeCall = needsScope(job) && !scopes.has(scopeKey(job));
    if (calls + (scopeCall ? 2 : 1) > maxCalls) return { done, stopped: true };
    const cwd = makeEmptyDir();
    try {
      const common = { model: judges[j], cwd, effort };
      entry.judged ??= [];
      if (entry.pass === 'intent') {
        const input = { issue: entry.source_text, tests: entry.tests, ...common };
        const scope = scopes.get(scopeKey(job)) ?? await judgeIssueScope(adapters[j], input);
        if (scope.ok) scopes.set(scopeKey(job), scope); // a failed scope is not kept: the next charter of the case asks again
        entry.judged[j] = await judgeIntent(adapters[j], { ...input, charter: entry.text, scope });
      } else {
        entry.judged[j] = await judgeOutput(adapters[j], { source: entry.source_text, output: entry.text, ...common });
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
    calls += scopeCall ? 2 : 1;
    done += 1;
    onProgress(done, jobs.length);
  }
  return { done, stopped: false };
}
