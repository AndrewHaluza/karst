import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_WORDS, checkContract, checkInjection, checkTight, checkVerbatim, extractVerbatimTokens, similarity } from './checks.mjs';
import { buildJudgePrompt, judgeOutput, parseJudge } from './judge.mjs';
import { loadCases, loadPromptSource, parseJsonl, readTicketRows, rowsToCases, sampleRows, stripFrontmatter } from './inputs.mjs';
import { exportOwnTickets, parseExportArgs } from './export.mjs';
import { cell, renderReport, sd, summarizeSource } from './report.mjs';
import { DEFAULT_CASES, parseArgs, runEval, writeResults } from './run.mjs';

const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'evalform-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('token extractor', () => {
  it('finds backticks, quotes, urls, versions, keys and error lines', () => {
    const t = extractVerbatimTokens('See `foo()` and "bad input here" at https://x.io/a?b=1 on v1.2.3 for T123, PROJ-9.\nTypeError: x is undefined\nplain line');
    expect(t).toEqual(expect.arrayContaining(['`foo()`', '"bad input here"', 'https://x.io/a?b=1', 'v1.2.3', 'T123', 'PROJ-9', 'TypeError: x is undefined']));
    expect(t).not.toContain('plain line');
  });
  it('de-duplicates', () => {
    expect(extractVerbatimTokens('T1 T1 T1').filter((x) => x === 'T1')).toHaveLength(1);
  });
});

describe('checks', () => {
  it('verbatim reports pct and missing', () => {
    expect(checkVerbatim('has A only', ['A', 'B'])).toMatchObject({ pct: 0.5, missing: ['B'] });
    expect(checkVerbatim('x', []).pct).toBeNull();
  });
  it('contract: fix needs Actual/Expected/Repro', () => {
    expect(checkContract('**Actual:** a\n**Expected:** b\n**Repro:** c', { type: 'fix' })).toEqual([]);
    expect(checkContract('**Actual:** a', { type: 'fix' })).toEqual(['missing Expected', 'missing Repro']);
  });
  it('contract: non-fix needs Why', () => {
    expect(checkContract('Do it.', { type: 'feat' })).toContain('missing Why');
    expect(checkContract('Do it.\n\n**Why:** x', { type: 'feat' })).toEqual([]);
  });
  it('word limit excludes verbatim', () => {
    const tok = Array(200).fill('w').join(' ');
    expect(checkContract(`**Why:** ${tok}`, { type: 'feat' }).some((v) => v.startsWith('over'))).toBe(true);
    expect(checkContract(`**Why:** ${tok}`, { type: 'feat', tokens: [tok] }).some((v) => v.startsWith('over'))).toBe(false);
    expect(MAX_WORDS).toBe(120);
  });
  it('flags paths, boilerplate, fences, json, preamble', () => {
    const v = checkContract('Sure, here\n**Why:** this ticket aims to edit src/a.ts\n```x```', { type: 'feat' });
    expect(v).toEqual(expect.arrayContaining(['path/file-like token', 'boilerplate "this ticket aims to"', 'code fence', 'preamble']));
    expect(checkContract('{"a":1}', { type: 'feat' })).toContain('json');
  });
  it('injection needs canary absent and a Note', () => {
    expect(checkInjection('x\n**Note:** found "CANARY"', 'CANARY')).toMatchObject({ ok: true });
    expect(checkInjection('x CANARY\n**Note:** y', 'CANARY').ok).toBe(false);
    expect(checkInjection('x', 'CANARY').ok).toBe(false);
  });
  it('tight uses normalized similarity', () => {
    expect(similarity('Hello, World!', 'hello world')).toBe(1);
    expect(checkTight('a b c d', 'a b c d').ok).toBe(true);
    expect(checkTight('totally different words', 'a b c d').ok).toBe(false);
  });
});

describe('judge parse', () => {
  const good = '{"lost":[{"item":"x","sourceQuote":"q"}],"invented":[]}';
  it('parses plain and fenced/prosed JSON', () => {
    expect(parseJudge(good)).toMatchObject({ ok: true, lost: [{ item: 'x' }] });
    expect(parseJudge('Here:\n```json\n' + good + '\n```')).toMatchObject({ ok: true });
  });
  it('unparsable is a judge-error, not zero', () => {
    for (const bad of ['', 'no json', '{bad', '{"lost":1,"invented":[]}', '{"lost":[]}']) {
      const r = parseJudge(bad);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^judge-error/);
    }
  });
  it('judgeOutput never throws and sends source+output only', async () => {
    let seen;
    const ad = { runHeadless: async (o) => { seen = o; return { raw: good }; } };
    expect((await judgeOutput(ad, { source: 'SRC', output: 'OUT', model: 'm', cwd: '/x' })).ok).toBe(true);
    expect(seen.prompt).toBe(buildJudgePrompt('SRC', 'OUT'));
    const boom = { runHeadless: async () => { throw new Error('down'); } };
    expect(await judgeOutput(boom, { source: 's', output: 'o', model: 'm', cwd: '/x' })).toEqual({ ok: false, error: 'judge-error: down' });
  });
});

describe('inputs', () => {
  it('shipped cases file is valid', () => {
    const cases = loadCases(DEFAULT_CASES);
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.some((c) => c.expect.canary)).toBe(true);
    expect(cases.every((c) => c.expect.verbatim.every((t) => c.input.includes(t)))).toBe(true);
  });
  it('rejects bad jsonl and bad cases', () => {
    expect(() => parseJsonl('{bad', 'f')).toThrow(/line 1/);
    const p = join(tmp(), 'c.jsonl');
    writeFileSync(p, '{"id":"a","title":"t","type":"fix","input":"x"}\n');
    expect(() => loadCases(p)).toThrow(/expect.verbatim/);
  });
  it('strips frontmatter and loads prompt sources', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\nBody here')).toBe('Body here');
    expect(stripFrontmatter('No fm')).toBe('No fm');
    expect(loadPromptSource('builtin')).toEqual({ name: 'builtin', body: null });
    expect(loadPromptSource('/a/b/improver.md', () => '---\nd: 1\n---\nDo X')).toEqual({ name: 'improver.md', body: 'Do X' });
    expect(() => loadPromptSource('e.md', () => '---\nd: 1\n---\n')).toThrow(/empty body/);
  });
  it('sampler is deterministic, seed-sensitive and id-ordered', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
    const a = sampleRows(rows, 5, 7);
    expect(sampleRows([...rows].reverse(), 5, 7)).toEqual(a);
    expect(a.map((r) => r.id)).toEqual([...a.map((r) => r.id)].sort((x, y) => x - y));
    expect(sampleRows(rows, 5, 8)).not.toEqual(a);
    expect(sampleRows(rows, 100, 1)).toHaveLength(30);
  });
  it('exports from a read-only db, brief not description, filters', () => {
    const dir = tmp();
    const dbPath = join(dir, 'k.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT, type TEXT, source TEXT, brief TEXT, description TEXT)');
    const long = 'Fix `foo` on v1.2.3 ' + 'x'.repeat(220);
    const ins = db.prepare('INSERT INTO tickets (title,type,source,brief,description) VALUES (?,?,?,?,?)');
    ins.run('a', 'fix', 'manual', long, 'IMPROVED');
    ins.run('b', null, 'planning', long, 'IMPROVED');
    ins.run('c', 'fix', 'jira', long, 'x');
    ins.run('d', 'fix', 'manual', 'short', 'x');
    db.close();
    expect(readTicketRows(dbPath).map((r) => r.title)).toEqual(['a', 'b']);
    const out = join(dir, 'sub', 'own.jsonl');
    expect(exportOwnTickets(['--db', dbPath, '--sample', '5', '--seed', '1'], out).count).toBe(2);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ id: 'own-1', type: 'fix', input: long });
    expect(rows[0].expect.verbatim).toEqual(expect.arrayContaining(['`foo`', 'v1.2.3']));
    expect(rows[1].type).toBe('feat');
    expect(JSON.stringify(rows)).not.toContain('IMPROVED');
    expect(rowsToCases([]).length).toBe(0);
  });
  it('export args validated', () => {
    expect(() => parseExportArgs([])).toThrow(/--db/);
    expect(() => parseExportArgs(['--db', 'x', '--sample', '0'])).toThrow(/sample/);
    expect(() => parseExportArgs(['--db', 'x', '--bogus'])).toThrow(/unknown/);
  });
});

describe('cli args', () => {
  const base = ['--model', 'a', '--judge-model', 'b'];
  it('defaults', () => {
    expect(parseArgs(base)).toMatchObject({ prompts: ['builtin'], runs: 3, provider: 'claude', cases: [DEFAULT_CASES] });
  });
  it('refuses equal / missing judge model, bad provider, runs, pass', () => {
    expect(() => parseArgs(['--model', 'a', '--judge-model', 'a'])).toThrow(/differ/);
    expect(() => parseArgs(['--model', 'a'])).toThrow(/judge-model/);
    expect(() => parseArgs(['--judge-model', 'a'])).toThrow(/--model/);
    expect(() => parseArgs([...base, '--provider', 'x'])).toThrow(/provider/);
    expect(() => parseArgs([...base, '--runs', '0'])).toThrow(/runs/);
    expect(() => parseArgs([...base, '--pass', 'classify'])).toThrow(/--pass/);
  });
  it('collects repeated prompts and --only', () => {
    const o = parseArgs([...base, '--prompt', 'builtin', '--prompt', 'p.md', '--only', 'a,b']);
    expect(o.prompts).toEqual(['builtin', 'p.md']);
    expect(o.only).toEqual(['a', 'b']);
  });
});

describe('table cell escaping', () => {
  it('escapes backslashes before pipes, and newlines', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('a\nb')).toBe('a<br>b');
  });
});

describe('runner + report', () => {
  const cases = [{ id: 'c1', title: 't', type: 'feat', input: 'Do the thing `x`', expect: { verbatim: ['`x`'] } }];
  const sources = [{ name: 'builtin', body: null }, { name: 'p.md', body: 'PROMPT' }];
  const judgeJson = '{"lost":[{"item":"l","sourceQuote":"q"}],"invented":[]}';
  const mk = (judgeRaw) => {
    const calls = [];
    const adapter = { runHeadless: async (o) => { calls.push(o); return { raw: o.prompt.includes('You audit') ? judgeRaw : 'x', usage: { inputTokens: 10, outputTokens: 5 } }; } };
    const improve = async (ad, input) => { const r = await ad.runHeadless({ prompt: input.instructions, cwd: input.cwd, model: input.model }); return `Do it \`x\`\n\n**Why:** ${r.raw}`; };
    return { calls, adapter, improve };
  };
  const opts = { runs: 2, model: 'm', judgeModel: 'j' };
  it('runs sequentially per source/case/run, judge in empty cwd, usage captured', async () => {
    const { calls, adapter, improve } = mk(judgeJson);
    const attempts = await runEval({ opts, cases, sources, improve, adapter, judgeAdapter: adapter, makeEmptyDir: tmp });
    expect(attempts).toHaveLength(4);
    expect(attempts.map((a) => [a.source, a.run])).toEqual([['builtin', 1], ['builtin', 2], ['p.md', 1], ['p.md', 2]]);
    expect(attempts[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(attempts[0].judge.ok).toBe(true);
    expect(calls.filter((c) => c.model === 'j')).toHaveLength(4);
    expect(attempts[0].checks.verbatim.pct).toBe(1);
  });
  it('a failing call becomes an error attempt, not a crash', async () => {
    const { adapter } = mk(judgeJson);
    const attempts = await runEval({ opts: { ...opts, runs: 1 }, cases, sources: [sources[0]], improve: async () => { throw new Error('cli down'); }, adapter, judgeAdapter: adapter, makeEmptyDir: tmp });
    expect(attempts[0].error).toBe('cli down');
    expect(summarizeSource(attempts)).toMatchObject({ callErrors: 1, verbatimPct: null, lostMean: null, tokensPerCall: null });
  });
  it('judge errors are counted and excluded, never zero', async () => {
    const { adapter, improve } = mk('garbage');
    const attempts = await runEval({ opts: { ...opts, runs: 1 }, cases, sources: [sources[0]], improve, adapter, judgeAdapter: adapter, makeEmptyDir: tmp });
    const s = summarizeSource(attempts);
    expect(s.judgeErrors).toBe(1);
    expect(s.lostMean).toBeNull();
    const md = renderReport({ meta: { startedAt: 'now', model: 'm', judgeModel: 'j', provider: 'claude', runs: 1, sources: ['builtin'] }, cases, attempts });
    expect(md).toContain('pending');
    expect(md).toContain('judge-error');
  });
  it('report shows side-by-side outputs, judge items, spread; results.json written', async () => {
    const { adapter, improve } = mk(judgeJson);
    const attempts = await runEval({ opts, cases, sources, improve, adapter, judgeAdapter: adapter, makeEmptyDir: tmp });
    const meta = { startedAt: 'now', model: 'm', judgeModel: 'j', provider: 'claude', runs: 2, sources: ['builtin', 'p.md'] };
    const md = renderReport({ meta, cases, attempts });
    expect(md).toContain('| builtin |');
    expect(md).toContain('| p.md |');
    expect(md).toContain('lost: l');
    expect(md).toContain('### c1 (feat) t');
    const dir = join(tmp(), 'out');
    writeResults(dir, { meta, cases, attempts });
    expect(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).attempts).toHaveLength(4);
    expect(sd([1])).toBeNull();
    expect(sd([1, 3])).toBeCloseTo(1.414, 2);
  });
});
