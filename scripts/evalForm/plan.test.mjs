import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planningInstructions } from '../../src/planning/preamble.ts';
import { validateProposal } from '../../src/planning/proposal.ts';
import { gitRunner } from './draftChecks.mjs';
import { buildPlanJudgePrompt, judgePlan, parsePlanJudge } from './planJudge.mjs';
import { buildPlanManifest, buildPlanPrompt, KICKOFF_LINE } from './planPrompt.mjs';
import { createdPaths, dirtyDefect, extractPaths, planStaticChecks } from './planChecks.mjs';
import { renderPlanReport, renderPlanRatings, summarizePlan } from './planReport.mjs';
import { planTools, runPlanEval, runPlannerHeadless } from './planRun.mjs';
import { parseArgs } from './run.mjs';

const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'evalplan-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GOOD = { title: 'T', description: 'edit src/old.ts', summary: 'S', repos: ['core'] };
const FIX = 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+x\n';
const writeDraft = (env, name, obj, mtime) => {
  mkdirSync(env.KARST_OUTBOX, { recursive: true });
  const p = join(env.KARST_OUTBOX, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  if (mtime) utimesSync(p, mtime, mtime);
};
const fakeAdapter = (fn) => ({ runHeadless: async (opts) => { await fn(opts); return { raw: '', usage: { inputTokens: 1, outputTokens: 2 } }; } });
const run = (adapter, extra = {}) => runPlannerHeadless({
  adapter, instructions: 'I', kickoff: 'K', checkout: tmp(), outbox: join(tmp(), 'outbox'), model: 'm', cliEntry: '/cli.js', timeoutMs: 1000, maxDrafts: 3, validate: validateProposal, ...extra,
});

describe('plan prompt', () => {
  it('holds the title and body, never the gold patch', () => {
    const p = buildPlanPrompt({ instructions: 'INS', title: 'Bug title', body: 'Bug body' });
    expect(p).toContain('Plan this issue: Bug title\n\nBug body');
    expect(p).not.toContain(FIX);
  });
  it('holds the instructions and the kickoff; the fake manifest validates', () => {
    const manifest = buildPlanManifest('core', '/work/core');
    const instructions = planningInstructions({ sessionId: 1, title: 'Bug title', manifest });
    const p = buildPlanPrompt({ instructions, title: 'Bug title', body: 'b' });
    expect(p).toContain(instructions);
    expect(p).toContain(KICKOFF_LINE);
    expect(p).toContain('No user is present. Propose the draft now.');
    expect(instructions).toContain('/work/core');
    expect(instructions).toContain('core');
  });
});

describe('runPlannerHeadless', () => {
  it('returns one draft and sets the env', async () => {
    let seen;
    const r = await run(fakeAdapter((o) => { seen = o; writeDraft(o.env, 'a.json', GOOD); }));
    expect(r.status).toBe('ok');
    expect(r.drafts).toEqual([expect.objectContaining({ title: 'T' })]);
    expect(seen.env.KARST_CLI).toBe('/cli.js');
    expect(seen.timeoutMs).toBe(1000);
    expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
  it('records invalid-proposal, not a crash', async () => {
    const r = await run(fakeAdapter((o) => writeDraft(o.env, 'a.json', { title: 'x' })));
    expect(r.status).toBe('invalid-proposal');
    expect(r.invalid).toHaveLength(1);
    const bad = await run(fakeAdapter((o) => writeDraft(o.env, 'a.json', 'not json')));
    expect(bad.status).toBe('invalid-proposal');
  });
  it('records no-draft, timeout and error', async () => {
    expect((await run(fakeAdapter(() => {}))).status).toBe('no-draft');
    const t = await run({ runHeadless: async () => { throw new Error('headless run timed out after 1000ms'); } });
    expect(t.status).toBe('timeout');
    const e = await run({ runHeadless: async () => { throw new Error('boom'); } });
    expect(e).toMatchObject({ status: 'error', error: 'boom' });
  });
  it('keeps the last file per id and truncates to max-drafts', async () => {
    const old = new Date(1000), recent = new Date(2000);
    const r = await run(fakeAdapter((o) => {
      writeDraft(o.env, 'a.json', { ...GOOD, id: 1, title: 'first' }, old);
      writeDraft(o.env, 'b.json', { ...GOOD, id: 1, title: 'second' }, recent);
      writeDraft(o.env, 'c.json', { ...GOOD, title: 'other' }, recent);
    }));
    expect(r.drafts.map((d) => d.title).sort()).toEqual(['other', 'second']);
    const cut = await run(fakeAdapter((o) => { for (const n of 'abcde') writeDraft(o.env, `${n}.json`, { ...GOOD, title: n }); }), { maxDrafts: 2 });
    expect(cut.drafts).toHaveLength(2);
  });
});

function makeRepo() {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/old.ts'), 'a\n');
  g('add', '.'); g('commit', '-qm', 'base');
  return { dir, git: gitRunner(dir), base: g('rev-parse', 'HEAD').trim() };
}

describe('plan static checks', () => {
  it('extracts path tokens and parses created paths', () => {
    expect(extractPaths('edit `src/old.ts`, then src/a/b.ts.')).toEqual(['src/old.ts', 'src/a/b.ts']);
    expect([...createdPaths(FIX)]).toEqual(['src/new.ts']);
  });
  it('accepts base and gold-created paths, flags an invented path and an empty part', () => {
    const r = makeRepo();
    const ctx = { git: r.git, baseSha: r.base, created: createdPaths(FIX), knownRepos: ['core'] };
    const ok = planStaticChecks({ ...ctx, draft: { ...GOOD, description: 'edit src/old.ts and src/new.ts' } });
    expect(ok).toMatchObject({ defects: [], pathRatio: 1, invented: [] });
    const bad = planStaticChecks({ ...ctx, draft: { ...GOOD, description: 'edit src/ghost.ts', summary: ' ', repos: ['nope'] } });
    expect(bad.invented).toEqual(['src/ghost.ts']);
    expect(bad.pathRatio).toBe(0);
    expect(bad.defects.map((d) => d.kind).sort()).toEqual(['empty-part', 'invented-path', 'unknown-repo']);
  });
  it('flags a dirty checkout as planner-edited-files', () => {
    const r = makeRepo();
    expect(dirtyDefect(r.git)).toBeNull();
    writeFileSync(join(r.dir, 'src/old.ts'), 'changed\n');
    expect(dirtyDefect(r.git)).toMatchObject({ kind: 'planner-edited-files' });
  });
});

const JUDGE_OK = '{"notDone":[{"item":"x"}],"unrequested":[],"f2pCoverage":[{"test":"t1","coverage":"partial"}],"verdict":"partial"}';

describe('plan judge', () => {
  const input = { issue: 'I', drafts: [GOOD], fixPatch: FIX, f2p: ['t1'], testFiles: ['a.test.ts'] };
  it('parses f2pCoverage; a wrong shape is judge-error', () => {
    expect(parsePlanJudge(JUDGE_OK)).toMatchObject({ ok: true, verdict: 'partial', f2pCoverage: [{ test: 't1', coverage: 'partial' }] });
    expect(parsePlanJudge(JUDGE_OK.replace('partial"}]', 'maybe"}]'))).toMatchObject({ ok: false });
    expect(parsePlanJudge('{"notDone":[],"unrequested":[],"verdict":"matches"}')).toMatchObject({ ok: false, error: expect.stringContaining('judge-error') });
    expect(parsePlanJudge('prose')).toMatchObject({ ok: false });
  });
  it('is blind, states the union rule, and refuses the planner model', async () => {
    const p = buildPlanJudgePrompt(input);
    expect(p).toContain(FIX);
    expect(p).toContain('union');
    let calls = 0;
    const adapter = { runHeadless: async (o) => { calls++; expect(o.model).toBe('judge'); return { raw: JUDGE_OK }; } };
    expect(await judgePlan(adapter, { ...input, model: 'judge', plannerModel: 'judge', cwd: '/x' })).toMatchObject({ ok: false, error: 'judge-wrote-draft' });
    expect(calls).toBe(0);
    expect(await judgePlan(adapter, { ...input, model: 'judge', plannerModel: 'p', cwd: '/x' })).toMatchObject({ ok: true });
  });
});

const row = (model, caseId, over = {}) => ({ caseId, model, status: 'ok', drafts: [GOOD], defects: [], seconds: 10, judge: parsePlanJudge(JUDGE_OK), ...over });

describe('plan report', () => {
  const results = [
    row('a', 'c1'),
    row('a', 'c2', { judge: { ok: false, error: 'judge-error: x' }, defects: [{ kind: 'invented-path', item: 'p' }] }),
    row('b', 'c1', { status: 'timeout', drafts: [], judge: undefined }),
  ];
  it('aggregates per model and excludes judge-error rows from means', () => {
    const s = summarizePlan(results.filter((r) => r.model === 'a'));
    expect(s).toMatchObject({ total: 2, scored: 1, judgeErrors: 1, notDone: 1, unrequested: 0, f2p: 0.5, defectRate: 0.5 });
    expect(summarizePlan(results.filter((r) => r.model === 'b'))).toMatchObject({ timeouts: 1, scored: 0, notDone: null });
  });
  it('renders the report and the ratings table', () => {
    const meta = { startedAt: 's', provider: 'claude', judgeModel: 'j' };
    expect(renderPlanReport({ meta, results })).toContain('## Per case');
    const t = renderPlanRatings({ meta, results });
    expect(t).toContain('| Rank | Model |');
    expect(t).toContain('**a**');
  });
});

describe('runPlanEval', () => {
  it('copies, runs, checks, judges and cleans up', async () => {
    const r = makeRepo();
    const cleaned = [];
    const item = { id: 'o/r:pr-1', repo: 'core', title: 'T', body: 'B', baseSha: r.base, fixPatch: FIX, testPatch: '+++ b/a.test.ts\n', f2p: ['t1'] };
    const out = await runPlanEval({
      opts: { judgeModel: 'j', maxDrafts: 3, timeoutMin: 1 }, items: [item], models: ['p'],
      adapter: fakeAdapter((o) => writeDraft(o.env, 'a.json', GOOD)), judgeAdapter: { runHeadless: async () => ({ raw: JUDGE_OK }) },
      makeWork: () => ({ checkout: r.dir, scratch: tmp(), cleanup: () => cleaned.push(1) }),
      buildPrompt: () => ({ instructions: 'I', kickoff: 'K' }), validate: validateProposal, cliEntry: '/cli.js', cwd: tmp(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ caseId: 'o/r:pr-1', model: 'p', status: 'ok', judge: { ok: true } });
    expect(cleaned).toEqual([1]);
  });
});

describe('plan args', () => {
  it('parses --pass plan and the new options', () => {
    const o = parseArgs(['--pass', 'plan', '--models', 'a,b', '--judge-model', 'j', '--only', 'x', '--timeout-min', '5', '--max-drafts', '2', '--publish']);
    expect(o).toMatchObject({ pass: 'plan', models: ['a', 'b'], judgeModel: 'j', only: ['x'], timeoutMin: 5, maxDrafts: 2, publish: true });
    const d = parseArgs(['--pass', 'plan', '--models', 'a', '--judge-model', 'j']);
    expect(d).toMatchObject({ timeoutMin: 10, maxDrafts: 3, publish: false });
  });
  it('rejects a missing model list and a judge equal to a planner model', () => {
    expect(() => parseArgs(['--pass', 'plan', '--judge-model', 'j'])).toThrow('--models');
    expect(() => parseArgs(['--pass', 'plan', '--models', 'a,j', '--judge-model', 'j'])).toThrow('differ');
    expect(() => parseArgs(['--pass', 'plan', '--models', 'a', '--judge-model', 'j', '--max-drafts', '0'])).toThrow('--max-drafts');
  });
});

describe('plan allowed tools and cleanup', () => {
  const CLI = '/abs/dist/cli/main.js';
  it('allow only the propose command, never a bare node', () => {
    const tools = planTools(CLI);
    expect(tools.some((x) => /Bash\(node:/.test(x))).toBe(false);
    expect(tools.filter((x) => x.startsWith('Bash(node'))).toEqual([`Bash(node ${CLI} draft propose:*)`, 'Bash(node "$KARST_CLI" draft propose:*)']);
  });
  it('the prompt propose command and the env path match an allowed pattern', async () => {
    const instructions = planningInstructions({ sessionId: 1, title: 't', manifest: buildPlanManifest('core', '/w') });
    const cmd = /\| (node "\$KARST_CLI" draft propose)/.exec(instructions)?.[1];
    const prefixes = planTools(CLI).filter((x) => x.startsWith('Bash(node')).map((x) => x.slice(5, -3));
    expect(prefixes).toContain(cmd);
    let seen;
    await run(fakeAdapter((o) => { seen = o; }), { cliEntry: CLI });
    expect(prefixes).toContain(`node ${seen.env.KARST_CLI} draft propose`);
    expect(seen.allowedTools).toEqual(planTools(CLI));
  });
  const setup = (adapter, judgeAdapter, seenOrder) => {
    const r = makeRepo();
    const item = { id: 'c', repo: 'core', title: 'T', body: 'B', baseSha: r.base, fixPatch: FIX, testPatch: '', f2p: [] };
    return runPlanEval({
      opts: { judgeModel: 'j', maxDrafts: 3, timeoutMin: 1 }, items: [item], models: ['p'], adapter, judgeAdapter,
      makeWork: () => ({ checkout: r.dir, scratch: tmp(), cleanup: () => seenOrder.push('cleanup') }),
      buildPrompt: () => ({ instructions: 'I', kickoff: 'K' }), validate: validateProposal, cliEntry: '/cli.js', cwd: tmp(),
    });
  };
  it('cleans up after a run error and a timeout, and still checks the copy after a timeout', async () => {
    const order = [];
    const out = await setup({ runHeadless: async () => { throw new Error('boom'); } }, null, order);
    expect(out[0]).toMatchObject({ status: 'error' });
    expect(order).toEqual(['cleanup']);
    const o2 = [];
    const r = makeRepo();
    const item = { id: 'c', repo: 'core', title: 'T', body: 'B', baseSha: r.base, fixPatch: FIX, testPatch: '', f2p: [] };
    const res = await runPlanEval({
      opts: { judgeModel: 'j', maxDrafts: 3, timeoutMin: 1 }, items: [item], models: ['p'],
      adapter: { runHeadless: async () => { writeFileSync(join(r.dir, 'src/old.ts'), 'edited\n'); throw new Error('timed out'); } }, judgeAdapter: null,
      makeWork: () => ({ checkout: r.dir, scratch: tmp(), cleanup: () => o2.push('cleanup') }),
      buildPrompt: () => ({ instructions: 'I', kickoff: 'K' }), validate: validateProposal, cliEntry: '/cli.js', cwd: tmp(),
    });
    expect(res[0].status).toBe('timeout');
    expect(res[0].defects.map((d) => d.kind)).toContain('planner-edited-files');
    expect(o2).toEqual(['cleanup']);
  });
  it('cleans up when the judge throws', async () => {
    const order = [];
    const out = await setup(fakeAdapter((o) => writeDraft(o.env, 'a.json', GOOD)), { runHeadless: async () => { throw new Error('judge down'); } }, order);
    expect(out[0].judge).toMatchObject({ ok: false, error: expect.stringContaining('judge down') });
    expect(order).toEqual(['cleanup']);
  });
});

describe('plan tokens and output folder', () => {
  it('sums totalTokens (cache included) for planner and judge separately', () => {
    const u = (totalTokens) => ({ inputTokens: 1, outputTokens: 2, totalTokens });
    const s = summarizePlan([row('a', 'c1', { usage: u(1000), judge: { ...parsePlanJudge(JUDGE_OK), usage: u(300) } }), row('a', 'c2', { usage: { inputTokens: 1, outputTokens: 2 } })]);
    expect(s).toMatchObject({ plannerTokens: 1003, judgeTokens: 300 });
    expect(renderPlanRatings({ meta: { provider: 'p', judgeModel: 'j', startedAt: 's' }, results: [] })).toContain('Rank');
    expect(renderPlanReport({ meta: { provider: 'p', judgeModel: 'j', startedAt: 's' }, results: [row('a', 'c1')] })).toContain('planner tokens (reported)');
  });
  it('the judge result carries the adapter usage', async () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 9 };
    const r = await judgePlan({ runHeadless: async () => ({ raw: JUDGE_OK, usage }) }, { issue: 'i', drafts: [GOOD], fixPatch: FIX, f2p: ['t1'], testFiles: [], model: 'j', plannerModel: 'p', cwd: '/x' });
    expect(r.usage).toEqual(usage);
  });
});
