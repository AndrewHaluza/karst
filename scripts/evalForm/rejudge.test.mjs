import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from './run.mjs';
import { buildJobs, collectResultFiles, pool, runRejudge, scanSelfIdentity, vendorOf } from './rejudge.mjs';
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
