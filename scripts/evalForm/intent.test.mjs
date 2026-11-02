import { describe, expect, it } from 'vitest';
import { checkCharter, countCalls, findLeaks, hunkForTest, parseOutcome, scenarioLines } from './intentChecks.mjs';
import { buildIntentJudgePrompt, coverageScore, judgeIntent, parseIntentJudge } from './intentJudge.mjs';
import { instanceItem, runIntentEval } from './intentRun.mjs';
import { renderIntentReport, summarizeMode } from './intentReport.mjs';
import { intentModes, parseArgs } from './run.mjs';

const CHARTER = '## Goal\nEmits work.\n\n## Scenarios\n- Given a form, when I submit, then it saves\n- Given nothing, when I wait, then nothing\n\n## Not in scope\n- x';
const T1 = 'packages/a/__tests__/x.spec.ts > suite > supports extended emits';
const PATCH = 'diff --git a/packages/a/__tests__/x.spec.ts b/packages/a/__tests__/x.spec.ts\nindex 1..2 100644\n--- a/packages/a/__tests__/x.spec.ts\n+++ b/packages/a/__tests__/x.spec.ts\n@@ -1,3 +1,4 @@\n+unrelated line\n@@ -10,3 +11,5 @@\n+test("supports extended emits", () => {})\n';

describe('intent checks', () => {
  it('counts adapter calls and maps outcomes', () => {
    const calls = [];
    const { adapter, state } = countCalls({ runHeadless: async (o) => { calls.push(o); return { raw: '' }; }, other: 1 });
    expect(adapter.other).toBe(1);
    return adapter.runHeadless({}).then(() => {
      expect(state.n).toBe(1);
      expect(parseOutcome({ text: 'x', degraded: false }, 1)).toBe('first-try');
      expect(parseOutcome({ text: 'x', degraded: false }, 2)).toBe('nudged');
      expect(parseOutcome({ text: null, degraded: true }, 2)).toBe('degraded');
    });
  });
  it('parses scenarios and flags non-GWT, paths, leaks; API identifiers are info only', () => {
    expect(scenarioLines(CHARTER)).toHaveLength(2);
    const r = { text: '## Goal\ng\n\n## Scenarios\n- Given a, when b, then c via `defineEmits`\n- just a line\n- Given a, when b, then see src/foo/bar.ts and x.spec.ts', degraded: false };
    const c = checkCharter({ result: r, calls: 1, f2p: [T1] });
    expect(c.scenarios).toBe(3);
    expect(c.nonGwt).toBe(1);
    expect(c.pathTokens).toEqual(expect.arrayContaining(['src/foo/bar.ts']));
    expect(c.leaks).toEqual(['file: packages/a/__tests__/x.spec.ts']);
    expect(c.apiIdentifiers).toContain('`defineEmits`');
  });
  it('degraded charter has empty checks', () => {
    expect(checkCharter({ result: { text: null, degraded: true }, calls: 2 })).toMatchObject({ outcome: 'degraded', scenarios: 0 });
  });
  it('flags a test title in the charter, ignores short titles', () => {
    expect(findLeaks('it supports extended emits now', [T1])).toEqual(['test: supports extended emits']);
    expect(findLeaks('it works', ['f.ts > s > works'])).toEqual([]);
  });
  it('picks the hunk that mentions the test title, falls back to all hunks', () => {
    const h = hunkForTest(PATCH, T1);
    expect(h).toContain('supports extended emits');
    expect(h).not.toContain('unrelated line');
    expect(hunkForTest(PATCH, 'packages/a/__tests__/x.spec.ts > s > other title')).toContain('unrelated line');
    expect(hunkForTest(PATCH, 'nope.ts > s > t')).toMatch(/no hunk/);
  });
});

describe('intent judge', () => {
  const good = JSON.stringify({ tests: [{ test: 'a', coverage: 'covered', scenario: 1, why: 'w' }, { test: 'b', coverage: 'not-in-issue', why: '' }], unsupported: [{ scenario: 2, why: 'u' }] });
  it('parses fenced JSON and orders by expected tests', () => {
    expect(parseIntentJudge('```json\n' + good + '\n```', ['b', 'a'])).toMatchObject({ ok: true, tests: [{ test: 'b' }, { test: 'a' }] });
  });
  it('rejects bad replies as judge-error', () => {
    expect(parseIntentJudge('nope', ['a']).error).toMatch(/no JSON/);
    expect(parseIntentJudge('{bad}', ['a']).error).toMatch(/invalid/);
    expect(parseIntentJudge('{"tests":[{"test":"a","coverage":"great"}],"unsupported":[]}', ['a']).error).toMatch(/shape/);
    expect(parseIntentJudge(good, ['a', 'zzz']).error).toMatch(/missing/);
  });
  it('scores covered=1 partial=0.5, excludes not-in-issue, null when nothing countable', () => {
    expect(coverageScore([{ coverage: 'covered' }, { coverage: 'partial' }, { coverage: 'missing' }, { coverage: 'not-in-issue' }]))
      .toMatchObject({ den: 3, pct: 0.5, notInIssue: 1, missing: 1 });
    expect(coverageScore([{ coverage: 'not-in-issue' }]).pct).toBeNull();
  });
  it('prompt carries issue, charter and hunks; adapter failure is a judge-error', async () => {
    const p = buildIntentJudgePrompt({ issue: 'ISS', charter: 'CHR', tests: [{ test: 'a', hunk: 'HUNK' }] });
    expect(p).toMatch(/ISS[\s\S]*CHR[\s\S]*HUNK/);
    const r = await judgeIntent({ runHeadless: async () => { throw new Error('boom'); } }, { issue: 'i', charter: 'c', tests: [], model: 'm', cwd: '/' });
    expect(r).toEqual({ ok: false, error: 'judge-error: boom' });
  });
});

describe('intent cli + runner', () => {
  const base = ['--pass', 'intent', '--model', 'a', '--judge-model', 'b'];
  it('parses sources and defaults to raw; refuses equal models and bad source', () => {
    expect(parseArgs(base)).toMatchObject({ pass: 'intent', sources: ['raw'], improvePrompt: 'builtin', cases: [] });
    expect(parseArgs([...base, '--source', 'raw', '--source', 'improved', '--improve-prompt', 'x.md']).sources).toEqual(['raw', 'improved']);
    expect(() => parseArgs([...base, '--source', 'zzz'])).toThrow(/--source/);
    expect(() => parseArgs(['--pass', 'intent', '--model', 'a', '--judge-model', 'a'])).toThrow(/differ/);
    expect(() => parseArgs(['--pass', 'x', '--model', 'a', '--judge-model', 'b'])).toThrow(/--pass/);
  });
  it('builds mode columns', () => {
    expect(intentModes({ sources: ['raw', 'improved'], improvePrompt: 'builtin' })).toMatchObject([{ name: 'raw' }, { name: 'improved:builtin', body: null }]);
  });

  const item = { id: 'i1', title: 'T', type: 'fix', brief: 'issue text', f2p: [T1], testPatch: PATCH };
  const judgeReply = JSON.stringify({ tests: [{ test: T1, coverage: 'partial', scenario: 1, why: 'half' }], unsupported: [] });
  const run = (modes, intent, improve = async () => 'IMPROVED') => runIntentEval({
    opts: { runs: 2, model: 'm', judgeModel: 'j' }, items: [item], modes, improve, intent,
    adapter: { runHeadless: async () => ({ raw: '' }) }, judgeAdapter: { runHeadless: async () => ({ raw: judgeReply }) },
    makeEmptyDir: () => '/nonexistent-eval-dir',
  });

  it('raw mode: intent gets brief only, test data never reaches it', async () => {
    const seen = [];
    const a = await run([{ name: 'raw', kind: 'raw' }], async (ad, input) => { seen.push(input); await ad.runHeadless({}); return { text: CHARTER, degraded: false }; });
    expect(a).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toMatch(/supports extended emits|x\.spec/);
    expect(seen[0].improvedDescription).toBeUndefined();
    expect(a[0]).toMatchObject({ checks: { outcome: 'first-try' }, judge: { ok: true } });
  });
  it('improved mode: improve runs first and feeds improvedDescription; improve error is a call error', async () => {
    const seen = [];
    const ok = await run([{ name: 'improved:builtin', kind: 'improved', body: null }], async (_a, input) => { seen.push(input); return { text: CHARTER, degraded: false }; });
    expect(seen[0].improvedDescription).toBe('IMPROVED');
    expect(ok[0].improved).toBe('IMPROVED');
    const bad = await run([{ name: 'improved:builtin', kind: 'improved' }], async () => ({ text: CHARTER, degraded: false }), async () => { throw new Error('nope'); });
    expect(bad[0].error).toBe('nope');
  });
  it('degraded charter skips the judge', async () => {
    const a = await run([{ name: 'raw', kind: 'raw' }], async () => ({ text: null, degraded: true }));
    expect(a[0].judge).toBeUndefined();
    expect(a[0].checks.outcome).toBe('degraded');
  });
  it('instanceItem keeps test data on the item, title from first issue', () => {
    const it2 = instanceItem({ task: { id: 'x', brief: 'b', f2p: ['f'], testPatch: 'p' }, row: { resolved_issues: [{ title: 'TT' }] } });
    expect(it2).toMatchObject({ title: 'TT', type: 'fix', f2p: ['f'], testPatch: 'p' });
  });

  it('report: coverage mean, sd over runs, judge errors excluded, pending tokens', async () => {
    const attempts = await run([{ name: 'raw', kind: 'raw' }], async () => ({ text: CHARTER, degraded: false }));
    attempts.push({ caseId: 'i1', source: 'raw', run: 3, charter: CHARTER, checks: attempts[0].checks, judge: { ok: false, error: 'judge-error: x' } });
    const s = summarizeMode(attempts);
    expect(s).toMatchObject({ coverage: 0.5, judgeErrors: 1, outcomes: { first: 3, nudged: 0, degraded: 0 } });
    const md = renderIntentReport({ meta: { provider: 'claude', model: 'm', judgeModel: 'j', runs: 3, startedAt: 's', sources: ['raw'] }, items: [item], attempts });
    expect(md).toMatch(/50\.0%/);
    expect(md).toMatch(/\*\*partial\*\*/);
    expect(md).toMatch(/pending/);
  });
});
