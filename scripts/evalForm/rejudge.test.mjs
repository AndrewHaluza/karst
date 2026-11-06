import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from './run.mjs';
import { buildJobs, collectResultFiles, countJudgeCalls, pool, runRejudge, scanSelfIdentity, vendorOf } from './rejudge.mjs';
import { agree, renderRejudgeReport } from './rejudgeReport.mjs';

const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rejudge-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const META = { startedAt: '2099-01-01T00:00:00.000Z', model: 'gemini-zz-secret', provider: 'antigravity', effort: 'turbo', judgeModel: 'old-judge-xyz', runs: 2, sources: ['builtin'] };
const caseOf = (id) => ({ id, title: 't', type: 'fix', input: `source text for ${id}`, expect: { verbatim: [] } });
const attempt = (caseId, run) => ({ caseId, source: 'builtin', run, output: `out ${caseId} ${run}`, judge: { ok: true, lost: [], invented: [] } });
const results = (attempts, meta = META) => ({ meta, cases: [], attempts });
const ctx = (cases) => ({ seed: 1, cases: new Map(cases.map((c) => [c.id, c])), instances: new Map() });
const okJudge = { ok: true, lost: [{ item: 'x' }], invented: [] };
const fakeAdapter = (prompts) => ({ runHeadless: async (o) => { prompts.push(o); return { raw: JSON.stringify({ lost: [{ item: 'x' }], invented: [] }) }; } });

describe('blind judging', () => {
  it('prompt carries no producer meta string, and runs in an empty cwd per call', async () => {
    const entries = pool([results([attempt('a', 1), attempt('b', 1)])], ctx([caseOf('a'), caseOf('b')]));
    const prompts = [];
    const dirs = [];
    await runRejudge({ jobs: buildJobs(entries, ['judge-m'], 1), judges: ['judge-m'], adapters: [fakeAdapter(prompts)], makeEmptyDir: () => { const d = tmp(); dirs.push(d); return d; } });
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      for (const s of [META.model, META.provider, META.effort, META.judgeModel, META.startedAt, 'results.json']) expect(p.prompt).not.toContain(s);
    }
    expect(new Set(prompts.map((p) => p.cwd)).size).toBe(2);
    expect(prompts.every((p) => dirs.includes(p.cwd))).toBe(true);
  });
  it('flags self-identifying output unless the source has the term', () => {
    expect(scanSelfIdentity('As an AI, I (Claude) rewrote it', 'plain')).toEqual(expect.arrayContaining(['as an ai', 'claude']));
    expect(scanSelfIdentity('use the claude cli', 'the Claude cli is broken')).toEqual([]);
  });
});

describe('intent issue scope', () => {
  const META_I = { ...META, pass: 'intent', sources: ['raw'] };
  const item = (id) => ({ id, brief: `issue ${id}`, f2p: ['t1', 't2'] });
  const charter = (caseId, source, model) => ({ caseId, source, run: 1, charter: `charter ${caseId} ${source} ${model}` });
  const entriesOf = (cases) => pool(['p1', 'p2'].map((model) => ({
    meta: { ...META_I, model }, items: cases.map(item),
    attempts: cases.flatMap((c) => ['raw', 'improved:builtin'].map((s) => charter(c, s, model))),
  })), ctx([]));
  const fake = (calls) => ({ runHeadless: async (o) => {
    calls.push(o);
    return { raw: o.prompt.includes('## CHARTER')
      ? JSON.stringify({ tests: [{ test: 't1', coverage: 'covered' }], unsupported: [] })
      : JSON.stringify({ tests: [{ test: 't1', inIssue: true }, { test: 't2', inIssue: false }] }) };
  } });

  it('decides the scope once per case and judge, so all charters of a case share one denominator', async () => {
    const entries = entriesOf(['a', 'b']);
    const calls = [[], []];
    const judges = ['j1', 'j2'];
    await runRejudge({ jobs: buildJobs(entries, judges, 1), judges, adapters: calls.map(fake), makeEmptyDir: tmp });
    for (const c of calls) {
      expect(c.filter((x) => !x.prompt.includes('## CHARTER'))).toHaveLength(2);
      expect(c.filter((x) => x.prompt.includes('## CHARTER'))).toHaveLength(8);
    }
    for (const e of entries) for (const r of e.judged) expect(r.tests.map((t) => t.coverage)).toEqual(['covered', 'not-in-issue']);
  });
  it('the scope prompt carries no charter and no producer meta', async () => {
    const entries = entriesOf(['a']);
    const calls = [];
    await runRejudge({ jobs: buildJobs(entries, ['j'], 1), judges: ['j'], adapters: [fake(calls)], makeEmptyDir: tmp });
    const scope = calls.filter((x) => !x.prompt.includes('## CHARTER'));
    expect(scope).toHaveLength(1);
    for (const s of ['charter a', 'p1', 'p2', META.judgeModel, META.startedAt]) expect(scope[0].prompt).not.toContain(s);
  });
  it('a failed scope is not kept: only that charter gets the judge error, and the next charter asks again', async () => {
    const entries = entriesOf(['a']);
    const calls = [];
    const good = fake([]);
    const adapter = { runHeadless: async (o) => { calls.push(o); return calls.length === 1 ? { raw: 'nope' } : good.runHeadless(o); } };
    await runRejudge({ jobs: buildJobs(entries, ['j'], 1), judges: ['j'], adapters: [adapter], makeEmptyDir: tmp });
    expect(calls.filter((x) => !x.prompt.includes('## CHARTER'))).toHaveLength(2);
    expect(entries.filter((e) => e.judged[0].ok === false).map((e) => e.judged[0].error)).toEqual([expect.stringMatching(/^judge-error: issue scope: /)]);
    expect(entries.filter((e) => e.judged[0].ok)).toHaveLength(3);
  });
  it('--max-calls counts scope calls and never exceeds the limit', async () => {
    const calls = [];
    const jobs = buildJobs(entriesOf(['a', 'b']), ['j'], 1);
    const r = await runRejudge({ jobs, judges: ['j'], adapters: [fake(calls)], maxCalls: 1, makeEmptyDir: tmp });
    expect(r).toEqual({ done: 0, stopped: true });
    expect(calls).toHaveLength(0);
    const more = [];
    const oneCase = buildJobs(entriesOf(['a']), ['j'], 1);
    const r2 = await runRejudge({ jobs: oneCase, judges: ['j'], adapters: [fake(more)], maxCalls: 3, makeEmptyDir: tmp });
    expect(r2).toEqual({ done: 2, stopped: true });
    expect(more).toHaveLength(3);
  });
  it('countJudgeCalls adds one scope call per case and judge, and none for improve or for no tests', () => {
    const judges = ['j1', 'j2'];
    expect(countJudgeCalls(buildJobs(entriesOf(['a', 'b']), judges, 1))).toEqual({ attempts: 16, scopes: 4, total: 20 });
    const improve = pool([results([attempt('a', 1)])], ctx([caseOf('a')]));
    expect(countJudgeCalls(buildJobs(improve, ['j'], 1))).toEqual({ attempts: 1, scopes: 0, total: 1 });
    const noTests = pool([{ meta: META_I, items: [{ id: 'a', brief: 'b', f2p: [] }], attempts: [charter('a', 'raw', 'p')] }], ctx([]));
    expect(countJudgeCalls(buildJobs(noTests, ['j'], 1))).toEqual({ attempts: 1, scopes: 0, total: 1 });
  });
});

describe('pooling', () => {
  it('no input -> skip no-input, error -> no-output; none judged', () => {
    const e = pool([results([attempt('gone', 1), { caseId: 'a', source: 'builtin', run: 1, error: 'boom' }])], ctx([caseOf('a')]));
    expect(e.map((x) => x.skip)).toEqual(['no-input', 'no-output']);
    expect(buildJobs(e, ['j'], 1)).toHaveLength(0);
  });
  it('job count = attempts x judges and order is seeded, not producer-grouped', () => {
    const cs = ['a', 'b', 'c', 'd', 'e', 'f'].map(caseOf);
    const e = pool([results(cs.map((c) => attempt(c.id, 1))), results(cs.map((c) => attempt(c.id, 1)), { ...META, model: 'other' })], ctx(cs));
    const jobs = buildJobs(e, ['j1', 'j2'], 7);
    expect(jobs).toHaveLength(24);
    expect(buildJobs(e, ['j1', 'j2'], 7).map((x) => x.entry.id)).toEqual(jobs.map((x) => x.entry.id));
    expect(jobs.slice(0, 12).map((x) => x.entry.producer.model).join()).not.toBe(jobs.map((x) => x.entry.producer.model).sort().slice(0, 12).join());
  });
  it('--max-calls stops cleanly', async () => {
    const e = pool([results([attempt('a', 1), attempt('b', 1)])], ctx([caseOf('a'), caseOf('b')]));
    const r = await runRejudge({ jobs: buildJobs(e, ['j'], 1), judges: ['j'], adapters: [fakeAdapter([])], maxCalls: 1, makeEmptyDir: tmp });
    expect(r).toEqual({ done: 1, stopped: true });
  });
  it('reads a dir of results', () => {
    const d = tmp(); mkdirSync(join(d, 'run1'));
    writeFileSync(join(d, 'run1', 'results.json'), JSON.stringify(results([attempt('a', 1)])));
    expect(collectResultFiles([d])).toHaveLength(1);
  });
});

describe('report + args', () => {
  it('shows old vs new, LOW, self-family, leaks, partial', async () => {
    const e = pool([results([{ ...attempt('a', 1), output: 'As an AI note' }], { ...META, model: 'claude-x' })], ctx([caseOf('a')]));
    await runRejudge({ jobs: buildJobs(e, ['claude-opus-5-5'], 1), judges: ['claude-opus-5-5'], adapters: [fakeAdapter([])], makeEmptyDir: tmp });
    const md = renderRejudgeReport({ judges: ['claude-opus-5-5'], entries: e, stopped: true, maxCalls: 1, files: 1, seed: 1, effort: 'low' });
    expect(md).toMatch(/LOW/); expect(md).toMatch(/self-family/); expect(md).toMatch(/\+1\.00/); expect(md).toMatch(/PARTIAL/); expect(md).toMatch(/as an ai/);
  });
  it('agreement compares counts / labels', () => {
    expect(agree(okJudge, { ...okJudge }, 'improve')).toBe(true);
    expect(agree(okJudge, { ok: false }, 'improve')).toBeNull();
  });
  it('parseArgs: rejudge needs no --model, repeats judges, validates', () => {
    const o = parseArgs(['--rejudge', 'a', '--rejudge', 'b', '--judge-model', 'j1', '--judge-model', 'j2', '--dry-run', '--max-calls', '5']);
    expect(o).toMatchObject({ rejudge: ['a', 'b'], judgeModels: ['j1', 'j2'], dryRun: true, maxCalls: 5 });
    expect(() => parseArgs(['--rejudge', 'a'])).toThrow(/judge-model/);
    expect(() => parseArgs(['--rejudge', 'a', '--judge-model', 'j', '--judge-model', 'j'])).toThrow(/differ/);
    expect(() => parseArgs(['--dry-run'])).toThrow(/--rejudge/);
  });
  it('vendorOf', () => { expect(vendorOf('claude-opus-5-5')).toBe('anthropic'); expect(vendorOf('gemini-3.8')).toBe('google'); expect(vendorOf('zzz')).toBeNull(); });
});
