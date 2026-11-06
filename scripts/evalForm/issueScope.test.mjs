import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIssueScopes, fixedScope, loadIssueScopes, majorityScope, parseIssueScopes, scopeCases } from './issueScope.mjs';
import { parseArgs } from './run.mjs';

const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'issue-scope-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tests = [{ test: 'a', hunk: 'A' }, { test: 'b', hunk: 'B' }];
const reply = (stated) => JSON.stringify({ tests: tests.map(({ test }) => ({ test, inIssue: stated.includes(test) })) });
const voter = (stated, calls = []) => ({ runHeadless: async (o) => { calls.push(o); return { raw: reply(stated) }; } });
const CASE = { caseId: 'c1', issue: 'ISSUE', tests };
const FILE = { meta: { judges: ['j1', 'j2', 'j3'], effort: 'medium' }, cases: { c1: { stated: ['a'], notStated: ['b'], votes: [] } } };

describe('majorityScope', () => {
  it('states a test only when more than half of the votes state it', () => {
    expect(majorityScope([{ stated: ['a', 'b'] }, { stated: ['a'] }, { stated: [] }], ['a', 'b'])).toEqual({ stated: ['a'], notStated: ['b'] });
  });
});

describe('buildIssueScopes', () => {
  const run = (adapters, extra = {}) => buildIssueScopes({ cases: [CASE], judges: ['j1', 'j2', 'j3'], adapters, effort: 'medium', makeEmptyDir: tmp, ...extra });

  it('records the majority and each vote, and passes the model and the effort', async () => {
    const calls = [];
    const r = await run([voter(['a', 'b'], calls), voter(['a']), voter([])]);
    expect(r.failed).toEqual([]);
    expect(r.cases.c1).toEqual({
      stated: ['a'], notStated: ['b'],
      votes: [{ judge: 'j1', stated: ['a', 'b'] }, { judge: 'j2', stated: ['a'] }, { judge: 'j3', stated: [] }],
    });
    expect(calls[0]).toMatchObject({ model: 'j1', effort: 'medium' });
  });
  it('asks again after one bad reply', async () => {
    const calls = [];
    const flaky = { runHeadless: async (o) => { calls.push(o); return { raw: calls.length === 1 ? 'nope' : reply(['a']) }; } };
    const r = await run([flaky, voter(['a']), voter(['a'])]);
    expect(calls).toHaveLength(2);
    expect(r.failed).toEqual([]);
  });
  it('reports a judge that fails twice and gives no scope for that case', async () => {
    const bad = { runHeadless: async () => ({ raw: 'nope' }) };
    const r = await run([bad, voter(['a']), voter(['a'])]);
    expect(r.cases).toEqual({});
    expect(r.failed).toEqual([{ caseId: 'c1', judge: 'j1', error: expect.stringMatching(/issue scope/) }]);
  });
});

describe('scopeCases', () => {
  it('gives each intent case with tests once, and skips other entries', () => {
    const entry = (over) => ({ pass: 'intent', caseId: 'c1', source_text: 'ISSUE', tests, ...over });
    const out = scopeCases([entry(), entry(), entry({ caseId: 'none', tests: [] }), entry({ caseId: 'skip', skip: 'no-output' }), { pass: 'improve', caseId: 'i' }]);
    expect(out).toEqual([CASE]);
  });
});

describe('scope file', () => {
  it('parses a valid file', () => {
    expect(parseIssueScopes(FILE).get('c1')).toMatchObject({ stated: ['a'], notStated: ['b'] });
  });
  it.each([
    [null], [{}], [{ cases: [] }], [{ cases: { c1: {} } }], [{ cases: { c1: { stated: 'a', notStated: [] } } }], [{ cases: { c1: { stated: ['a'], notStated: [1] } } }],
  ])('rejects a wrong shape: %j', (bad) => {
    expect(() => parseIssueScopes(bad)).toThrow(/scope file/);
  });
  it('reports a missing or invalid file', () => {
    const d = tmp();
    expect(() => loadIssueScopes(join(d, 'none.json'))).toThrow(/scope file not found/);
    const f = join(d, 'bad.json');
    writeFileSync(f, '{bad');
    expect(() => loadIssueScopes(f)).toThrow(/scope file/);
    writeFileSync(f, JSON.stringify(FILE));
    expect(loadIssueScopes(f).has('c1')).toBe(true);
  });
});

describe('fixedScope', () => {
  const scopes = parseIssueScopes(FILE);
  it('returns the saved scope for matching tests', () => {
    expect(fixedScope(scopes, 'c1', tests)).toEqual({ ok: true, stated: ['a'], notStated: ['b'] });
  });
  it('needs no scope for a case with no tests', () => {
    expect(fixedScope(scopes, 'other', [])).toEqual({ ok: true, stated: [], notStated: [] });
  });
  it('gives a judge error, not a silent not-in-issue, for a missing case or an unknown test', () => {
    expect(fixedScope(scopes, 'other', tests).error).toMatch(/^judge-error: issue scope: no scope for case other/);
    expect(fixedScope(scopes, 'c1', [...tests, { test: 'new', hunk: '' }]).error).toMatch(/^judge-error: issue scope: test not in scope: new/);
  });
});

describe('cli', () => {
  const base = ['--rejudge', 'a', '--judge-model', 'j1'];
  const three = ['--rejudge', 'a', '--judge-model', 'j1', '--judge-model', 'j2', '--judge-model', 'j3'];
  it('--build-scope needs an odd number of at least three judges, with no call limit and no scope file', () => {
    expect(parseArgs([...three, '--build-scope', 'f.json']).buildScope).toBe('f.json');
    expect(() => parseArgs([...base, '--build-scope', 'f'])).toThrow(/odd number/);
    expect(() => parseArgs([...base, '--judge-model', 'j2', '--build-scope', 'f'])).toThrow(/odd number/);
    expect(() => parseArgs([...three, '--build-scope', 'f', '--max-calls', '2'])).toThrow(/--max-calls/);
    expect(() => parseArgs([...three, '--build-scope', 'f', '--scope-file', 'g'])).toThrow(/--scope-file/);
    expect(() => parseArgs(['--model', 'm', '--judge-model', 'j', '--build-scope', 'f'])).toThrow(/--rejudge/);
  });
  it('--scope-file works with --rejudge and the intent pass only', () => {
    expect(parseArgs([...base, '--scope-file', 'f']).scopeFile).toBe('f');
    expect(parseArgs(['--pass', 'intent', '--model', 'a', '--judge-model', 'b', '--scope-file', 'f']).scopeFile).toBe('f');
    expect(() => parseArgs(['--model', 'a', '--judge-model', 'b', '--prompt', 'builtin', '--scope-file', 'f'])).toThrow(/--scope-file/);
  });
});
