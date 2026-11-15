import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_MATCH_WINDOW, scoreReview } from './reviewChecks.mjs';
import { buildReviewCheckout, probeCoreVersion, runReviewCase } from './reviewRun.mjs';

const tmps = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'revtest-')); tmps.push(d); return d; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const DEFECT = { id: 'D1', file: 'src/a.ts', lineStart: 10, lineEnd: 12, kind: 'bug', minSeverity: 'medium' };
const finding = (over = {}) => ({ severity: 'high', repo: 'r', file: 'src/a.ts', line: 11, title: 't', detail: 'd', source: 'review', ...over });
const meta = { tier: 'whole-doc', shape: 'object', droppedCheckoutClaims: 0 };
const score = (defects, findings, extra = {}) => scoreReview({ defects, findings, ...meta, ...extra });

describe('scoreReview', () => {
  it('matches a finding in the file inside the line window', () => {
    const r = score([DEFECT], [finding({ line: 10 - REVIEW_MATCH_WINDOW }), finding({ line: 99 })]);
    expect(r.found).toEqual(['D1']);
    expect(r.missed).toEqual([]);
    expect(r.falseFindings).toBe(1);
  });

  it('does not match a finding outside the window, in another file, or with no line', () => {
    const r = score([DEFECT], [
      finding({ line: 12 + REVIEW_MATCH_WINDOW + 1 }),
      finding({ file: 'src/b.ts' }),
      finding({ line: null }),
      finding({ file: null }),
    ]);
    expect(r.found).toEqual([]);
    expect(r.missed).toEqual(['D1']);
    expect(r.falseFindings).toBe(4);
  });

  it('lets one defect match at most one finding; a second finding on it is a duplicate', () => {
    const r = score([DEFECT], [finding({ line: 10, title: 'first' }), finding({ line: 11, title: 'second' })]);
    expect(r.found).toEqual(['D1']);
    expect(r.duplicates).toBe(1);
    expect(r.falseFindings).toBe(0);
  });

  it('matches a finding to the nearest defect when two windows overlap', () => {
    const d7 = { ...DEFECT, id: 'D7', lineStart: 4, lineEnd: 4 };
    const d8 = { ...DEFECT, id: 'D8', lineStart: 8, lineEnd: 8 };
    const r = score([d7, d8], [finding({ line: 7 }), finding({ line: 4 })]);
    expect(r.found.sort()).toEqual(['D7', 'D8']);
    expect(r.falseFindings).toBe(0);
  });

  it('does not match a finding that is below the defect minimum severity', () => {
    const r = score([DEFECT], [finding({ line: 11, severity: 'low' })]);
    expect(r.found).toEqual([]);
    expect(r.missed).toEqual(['D1']);
  });

  it('lets one finding match at most one defect', () => {
    const near = { ...DEFECT, id: 'D2', lineStart: 13, lineEnd: 14 };
    const r = score([DEFECT, near], [finding({ line: 12 })]);
    expect(r.found).toEqual(['D1']);
    expect(r.missed).toEqual(['D2']);
  });

  it('counts blockingFalse for false findings at high or critical only', () => {
    const r = score([], [
      finding({ severity: 'critical', line: 1 }),
      finding({ severity: 'high', line: 2 }),
      finding({ severity: 'medium', line: 3 }),
      finding({ severity: 'low', line: 4 }),
    ]);
    expect(r.falseFindings).toBe(4);
    expect(r.blockingFalse).toBe(2);
  });

  it('marks a clean case with a false finding as failed, and a clean answer as passed', () => {
    expect(score([], [finding()]).caseFailed).toBe(true);
    expect(score([], []).caseFailed).toBe(false);
    expect(score([DEFECT], [finding()]).caseFailed).toBe(false);
  });

  it('copies tier, shape and droppedCheckoutClaims from the runner result', () => {
    const r = score([DEFECT], [], { tier: 'fenced', shape: 'array', droppedCheckoutClaims: 2 });
    expect(r.parseTier).toBe('fenced');
    expect(r.shape).toBe('array');
    expect(r.droppedCheckoutClaims).toBe(2);
  });

  it('does not mutate its input', () => {
    const findings = [finding()];
    const defects = [DEFECT];
    const before = JSON.stringify({ findings, defects });
    score(defects, findings);
    expect(JSON.stringify({ findings, defects })).toBe(before);
  });
});

// ---- reviewRun.mjs (tasks 2, 2a, 2b) ----
const CASE = {
  id: 'c1', title: 'Off by one in the loop bound', baseRef: 'main', branch: 'feat/loop',
  defects: [{ id: 'REVEVAL-D-001', file: 'src/a.ts', lineStart: 2, lineEnd: 2, kind: 'bug', minSeverity: 'medium' }],
  cleanFiles: [],
};
function makeCase() {
  const dir = mk();
  mkdirSync(join(dir, 'repo/base/src'), { recursive: true });
  mkdirSync(join(dir, 'repo/change/src'), { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify(CASE));
  writeFileSync(join(dir, 'repo/base/src/a.ts'), 'export const a = (n: number) => {\n  return n;\n};\n');
  writeFileSync(join(dir, 'repo/change/src/a.ts'), 'export const a = (n: number) => {\n  return n + 1;\n};\n');
  return dir;
}
const fileList = (root) => readdirSync(root, { recursive: true }).filter((p) => !p.startsWith('.git') && statSync(join(root, p)).isFile());
const found = (extra) => JSON.stringify([{ severity: 'high', file: 'src/a.ts', line: 2, title: 'Wrong result', detail: 'adds one' }, ...(extra ?? [])]);
const fake = (raw, probe) => ({
  runHeadless: async (opts) => {
    probe?.(opts);
    if (typeof raw === 'function') return raw(opts);
    return { raw, finalMessage: undefined, usage: { totalTokens: 7 } };
  },
});
const run = (adapter, dir, over = {}) => runReviewCase({ adapter, caseDef: CASE, caseDir: dir, model: 'm', timeoutMs: 5000, max: 50, ...over });

describe('scoreReview duplicates', () => {
  it('counts a second finding on an already found defect as a duplicate, not a false finding', () => {
    const r = score([DEFECT], [finding({ line: 11 }), finding({ line: 12, title: 'same defect again' })]);
    expect(r.found).toEqual(['D1']);
    expect(r.duplicates).toBe(1);
    expect(r.falseFindings).toBe(0);
    expect(r.caseFailed).toBe(false);
  });
  it('still counts a finding far from every defect as false', () => {
    const r = score([DEFECT], [finding({ line: 11 }), finding({ line: 40 })]);
    expect(r.duplicates).toBe(0);
    expect(r.falseFindings).toBe(1);
  });
});

describe('buildReviewCheckout (2a, 2b)', () => {
  it('puts HEAD on the case branch, keeps local main, and gives a local bare origin outside the work tree', () => {
    const w = buildReviewCheckout(makeCase(), CASE);
    tmps.push(w.root);
    expect(git(w.checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/loop');
    expect(git(w.checkout, 'rev-parse', '--verify', 'main').trim()).toMatch(/^[0-9a-f]{40}$/);
    const origin = git(w.checkout, 'remote', 'get-url', 'origin').trim();
    expect(relative(w.checkout, origin).startsWith('..')).toBe(true);
    expect(git(w.checkout, 'diff', 'origin/main...origin/feat/loop')).toContain('+  return n + 1;');
    expect(realpathSync(w.checkout)).toBe(w.checkout);
    w.cleanup();
    expect(() => statSync(w.root)).toThrow();
  });

  it('uses generic commit messages and copies no case.json', () => {
    const w = buildReviewCheckout(makeCase(), CASE);
    tmps.push(w.root);
    expect(git(w.checkout, 'log', '--format=%s', 'main..HEAD').trim()).toBe('change');
    expect(git(w.checkout, 'log', '--format=%s', 'main').trim()).toBe('base');
    expect(fileList(w.checkout)).toEqual(['src/a.ts']);
  });
});

describe('runReviewCase', () => {
  it('does not call an error that only contains the letters "timeout" inside a word a timeout', async () => {
    const r = await run(fake(() => { throw new Error('mustertimeoutish failure'); }), makeCase());
    expect(r.status).toBe('error');
  });
  it('builds the prompt and call like the lane, and leaks no answer key into the work tree', async () => {
    let seen;
    const r = await run(fake(found(), (o) => {
      seen = { opts: o, files: fileList(o.cwd).map((p) => readFileSync(join(o.cwd, p), 'utf8')).join('\n') };
    }), makeCase());
    expect(r.status).toBe('ok');
    expect(seen.opts.policy).toBe('reviewer');
    expect(seen.opts.tracking.callSite).toBe('eval-form-review');
    expect(seen.opts.allowedTools).toBeUndefined();
    expect(seen.opts.outputSchema).toBeUndefined();
    expect(seen.opts.prompt).toContain('feat/loop');
    expect(seen.opts.prompt).not.toContain('Off by one');
    expect(seen.files).not.toContain('REVEVAL-D-001');
    expect(seen.files).not.toContain(CASE.title);
  });

  it('sets outputSchema only when the adapter declares structured output', async () => {
    let seen;
    const adapter = { ...fake(found(), (o) => { seen = o; }), surfaces: { structuredOutput: { supported: true }, structuredOutputForm: undefined } };
    await run(adapter, makeCase());
    expect(seen.outputSchema).toBeTruthy();
  });

  it('returns parsed findings with tier, shape, usage and no dropped claims', async () => {
    const r = await run(fake(found()), makeCase());
    expect(r.findings.map((f) => [f.file, f.line])).toEqual([['src/a.ts', 2]]);
    expect(r.tier).toBeTruthy();
    expect(r.shape).toBeTruthy();
    expect(r.droppedCheckoutClaims).toBe(0);
    expect(r.usage).toEqual({ totalTokens: 7 });
  });

  it('removes the coverage entry from the findings', async () => {
    const cov = { severity: 'info', file: null, line: null, title: 'COVERAGE (reported): PASS — src/a.ts', detail: 'x' };
    const r = await run(fake(found([cov])), makeCase());
    expect(r.findings).toHaveLength(1);
  });

  it('drops a disproven wrong-checkout claim and counts it', async () => {
    const claim = { severity: 'critical', file: null, line: null, title: 'Wrong checkout', detail: 'x' };
    const r = await run(fake(found([claim])), makeCase());
    expect(r.findings.some((f) => f.title === 'Wrong checkout')).toBe(false);
    expect(r.droppedCheckoutClaims).toBe(1);
  });

  it('removes the checkout after the run, even when the run fails', async () => {
    let cwd;
    const r = await run(fake(() => { throw new Error('boom'); }, (o) => { cwd = o.cwd; }), makeCase());
    expect(r.status).toBe('error');
    expect(r.findings).toEqual([]);
    expect(() => statSync(cwd)).toThrow();
  });

  it('reports unreadable output as an error, not as a clean pass', async () => {
    const r = await run(fake('I cannot help with that.'), makeCase());
    expect(r.status).toBe('error');
    expect(r.error).toContain('unreadable');
  });

  it('reports blank output as an error', async () => {
    const r = await run(fake('   '), makeCase());
    expect(r.status).toBe('error');
  });

  it('still reports a whole-message empty array as a clean answer', async () => {
    const r = await run(fake('[]'), makeCase());
    expect(r.status).toBe('ok');
    expect(r.findings).toEqual([]);
  });

  it('maps a timeout error to status timeout and never throws', async () => {
    const r = await run(fake(() => { throw new Error('headless timed out after 5000ms'); }), makeCase());
    expect(r.status).toBe('timeout');
  });
});

// ---- reviewReport.mjs (task 3) ----
import { MIN_N, renderReviewReport, summarizeCandidate, wilson } from './reviewReport.mjs';

const okRun = (over = {}) => ({ status: 'ok', seeded: 1, clean: false, found: 1, falseFindings: 0, blockingFalse: 0, caseFailed: false, tokens: 100, seconds: 2, ...over });

describe('wilson', () => {
  it('returns null for n = 0', () => { expect(wilson(0, 0)).toBeNull(); });
  it('gives the 95% interval for 8 of 10', () => {
    const w = wilson(8, 10);
    expect(w.p).toBeCloseTo(0.8, 5);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
  });
  it('keeps the bounds inside 0..1 at the extremes', () => {
    expect(wilson(0, 5).lo).toBe(0);
    expect(wilson(5, 5).hi).toBe(1);
  });
});

describe('summarizeCandidate', () => {
  it('counts recall over seeded defects and false-finding rate over clean cases', () => {
    const s = summarizeCandidate([
      okRun({ seeded: 2, found: 1 }),
      okRun({ seeded: 0, clean: true, found: 0, falseFindings: 2, blockingFalse: 1, caseFailed: true }),
      okRun({ seeded: 0, clean: true, found: 0 }),
      { status: 'timeout', seeded: 1, clean: false },
      { status: 'error', seeded: 1, clean: false },
    ]);
    expect(s.recall).toMatchObject({ k: 1, n: 2 });
    expect(s.cleanFailed).toMatchObject({ k: 1, n: 2 });
    expect(s.blockingFalse).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.timeouts).toBe(1);
    expect(s.meanTokens).toBe(100);
  });
  it('flags INSUFFICIENT below MIN_N', () => {
    expect(summarizeCandidate([okRun()]).recall.insufficient).toBe(true);
    const many = Array.from({ length: MIN_N }, () => okRun());
    expect(summarizeCandidate(many).recall.insufficient).toBe(false);
  });
});

describe('renderReviewReport', () => {
  const meta = { command: 'npm run -s eval:form -- --pass review', caseSetVersion: 1, buildSha: 'abc123', coreVersions: { claude: '1.0' } };
  const cand = (name) => ({ core: name, model: 'm', effort: 'low', runs: [okRun()] });
  it('prints the command, versions and INSUFFICIENT, and does not rank below MIN_N', () => {
    const md = renderReviewReport({ ...meta, candidates: [cand('claude'), cand('codex')] });
    expect(md).toContain(meta.command);
    expect(md).toContain('abc123');
    expect(md).toContain('INSUFFICIENT');
    expect(md).toContain('No ranking');
  });
  it('states how many calls did not finish, because recall counts only finished runs', () => {
    const md = renderReviewReport({ ...meta, candidates: [{ core: 'c', model: 'm', effort: null, runs: [okRun(), { status: 'timeout', seeded: 1, clean: false }] }] });
    expect(md).toContain('Recall and false-finding rates count only the runs that finished ok.');
    expect(md).toContain('1 of 2 calls did not finish');
  });
  it('escapes pipes in cells', () => {
    const md = renderReviewReport({ ...meta, candidates: [{ ...cand('a|b') }] });
    expect(md).toContain('a\\|b');
  });
});

// ---- task 4: flags and bench loop ----
import { parseArgs } from './run.mjs';
import { runReviewBench } from './reviewRun.mjs';

describe('--pass review flags', () => {
  const base = ['--pass', 'review', '--model', 'm'];
  it('needs only a model and defaults the cases dir', () => {
    const o = parseArgs(base);
    expect(o.pass).toBe('review');
    expect(o.casesDir).toMatch(/evals\/form\/review-cases$/);
    expect(parseArgs([...base, '--cases-dir', 'x']).casesDir).toBe('x');
  });
  it('requires --model', () => { expect(() => parseArgs(['--pass', 'review'])).toThrow('--model'); });
  it('rejects an invalid --runs', () => {
    for (const v of ['0', '1.5', 'x']) expect(() => parseArgs([...base, '--runs', v])).toThrow('--runs');
  });
  it('rejects an invalid --max-calls and accepts a positive integer', () => {
    for (const v of ['0', '2.5', 'x']) expect(() => parseArgs([...base, '--max-calls', v])).toThrow('--max-calls');
    expect(parseArgs([...base, '--max-calls', '4']).maxCalls).toBe(4);
  });
  it('rejects a non-positive --timeout-min', () => { expect(() => parseArgs([...base, '--timeout-min', '0'])).toThrow('--timeout-min'); });
});

describe('runReviewBench', () => {
  const cases = [{ dir: null, def: CASE }, { dir: null, def: { ...CASE, id: 'c2' } }];
  const mkCases = () => cases.map((c) => ({ ...c, dir: makeCase() }));
  it('runs each case runs times, in order, and records the case id', async () => {
    const out = await runReviewBench({ adapter: fake(found()), cases: mkCases(), model: 'm', timeoutMs: 5000, max: 50, runs: 2 });
    expect(out.map((r) => r.caseId)).toEqual(['c1', 'c1', 'c2', 'c2']);
    expect(out.every((r) => r.status === 'ok')).toBe(true);
  });
  it('stops when the call count reaches maxCalls', async () => {
    let calls = 0;
    const out = await runReviewBench({ adapter: fake(() => { calls++; return { raw: found(), usage: {} }; }), cases: mkCases(), model: 'm', timeoutMs: 5000, max: 50, runs: 2, maxCalls: 3 });
    expect(calls).toBe(3);
    expect(out).toHaveLength(3);
  });
});

// ---- task 5: the shipped case set ----
import { REVIEW_CASES } from './run.mjs';

describe('review case set v2', () => {
  const ids = readdirSync(REVIEW_CASES).filter((n) => statSync(join(REVIEW_CASES, n)).isDirectory());
  const load = (id) => JSON.parse(readFileSync(join(REVIEW_CASES, id, 'case.json'), 'utf8'));

  it('has 18 cases: 11 with one defect, 3 with two, 4 clean', () => {
    const counts = ids.map((id) => load(id).defects.length).sort();
    expect(counts).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2]);
  });

  it('has unique defect ids that are absent from the seeded code', () => {
    const all = ids.flatMap((id) => load(id).defects.map((d) => d.id));
    expect(new Set(all).size).toBe(all.length);
    for (const id of ids) {
      const w = buildReviewCheckout(join(REVIEW_CASES, id), load(id));
      tmps.push(w.root);
      const text = fileList(w.checkout).map((p) => readFileSync(join(w.checkout, p), 'utf8')).join('\n');
      for (const d of all) expect(text).not.toContain(d);
      expect(text).not.toMatch(/\b(bug|vulnerab|injection|off-by-one)\b/i);
    }
  });

  it.each(ids)('%s builds a repo whose branch differs from main and whose defects point at real lines', (id) => {
    const def = load(id);
    expect(def.id).toBe(id);
    const w = buildReviewCheckout(join(REVIEW_CASES, id), def);
    tmps.push(w.root);
    expect(git(w.checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(def.branch);
    expect(git(w.checkout, 'rev-parse', 'main').trim()).not.toBe(git(w.checkout, 'rev-parse', 'HEAD').trim());
    expect(git(w.checkout, 'diff', 'origin/main...origin/' + def.branch).length).toBeGreaterThan(0);
    for (const d of def.defects) {
      const lines = readFileSync(join(w.checkout, d.file), 'utf8').split('\n');
      expect(lines.length).toBeLessThan(80);
      expect(lines[d.lineStart - 1]?.trim().length).toBeGreaterThan(0);
      expect(d.file.startsWith('./')).toBe(false);
    }
  });
});

// ---- task 7: mainReview smoke with a fake adapter ----
import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import { main } from './run.mjs';

vi.mock('../../src/agent/registry.ts', () => ({
  resolveAdapter: () => ({ runHeadless: async () => ({ raw: '[]', finalMessage: undefined, usage: { totalTokens: 5 } }) }),
}));

describe('mainReview smoke', () => {
  it('runs one case end to end and writes report.md and results.json', async () => {
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => { lines.push(String(l)); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await main(['--pass', 'review', '--model', 'm', '--only', 'c01-loop-bound', '--runs', '1']);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    const report = lines.find((l) => l.startsWith('report: '))?.slice('report: '.length);
    expect(report).toBeTruthy();
    tmps.push(join(report, '..'));
    expect(readFileSync(report, 'utf8')).toContain('INSUFFICIENT');
    const res = JSON.parse(readFileSync(join(report, '..', 'results.json'), 'utf8'));
    expect(res.candidate.runs).toHaveLength(1);
    expect(res.candidate.runs[0]).toMatchObject({ caseId: 'c01-loop-bound', status: 'ok', found: 0, seeded: 1 });
    expect(existsSync(join(report, '..'))).toBe(true);
  });
});

describe('mainReview case loading and labels', () => {
  it('names the case file when a case.json cannot be parsed', async () => {
    const dir = mk();
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', 'case.json'), '{ not json');
    await expect(main(['--pass', 'review', '--model', 'm', '--cases-dir', dir])).rejects.toThrow(/bad[\\/]case\.json/);
  });
  it('labels the report with the core that ran, not the alias', async () => {
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => { lines.push(String(l)); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await main(['--pass', 'review', '--provider', 'opencode', '--model', 'm', '--only', 'c01-loop-bound', '--runs', '1']);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    const report = lines.find((l) => l.startsWith('report: '))?.slice('report: '.length);
    tmps.push(join(report, '..'));
    expect(JSON.parse(readFileSync(join(report, '..', 'results.json'), 'utf8')).candidate.core).toBe('opencode2');
  });
});

describe('probeCoreVersion', () => {
  it('returns the first line of the version output for the binary of a core', () => {
    const seen = [];
    const v = probeCoreVersion('opencode2', (bin, args) => { seen.push([bin, args]); return '1.4.2\nextra line\n'; });
    expect(v).toBe('1.4.2');
    expect(seen).toEqual([['opencode', ['--version']]]);
  });
  it('returns "unknown" for an unknown core or a failing probe', () => {
    expect(probeCoreVersion('nope', () => 'x')).toBe('unknown');
    expect(probeCoreVersion('claude', () => { throw new Error('missing'); })).toBe('unknown');
  });
});
