// Pinned LLM judge for the intent pass, in two steps:
// 1. Issue scope: issue + hidden tests, no charter. Decides once per case which tests the issue states.
// 2. Charter: issue + charter + the stated tests. The other tests become not-in-issue without a judge opinion.
// Unparsable -> judge-error (counted, excluded, never 0).

const CHARTER_COVERAGE = ['covered', 'partial', 'missing'];
const NOT_STATED_WHY = 'The issue scope step decided that the issue does not state this behaviour.';

export const ISSUE_SCOPE_RUBRIC = [
  'You read a ticket (ISSUE) and hidden tests (name + test hunk). For each test decide whether the ISSUE states the behaviour that the test checks.',
  'inIssue true = the ISSUE states the behaviour, or the behaviour follows directly from a statement in the ISSUE. inIssue false = the ISSUE never mentions the behaviour, so a reader of the ISSUE cannot be expected to know it.',
  'Reply with JSON only, no prose, no code fence:',
  '{"tests":[{"test":"<exact test name>","inIssue":true|false,"why":"..."}]}',
  'Return one entry per listed test, using the test name exactly.',
].join('\n');

export const INTENT_RUBRIC = [
  'You audit a black-box test charter written from a ticket (ISSUE). Each hidden test (name + test hunk) checks behaviour that the ISSUE states. For each test decide whether the CHARTER covers that behaviour.',
  'coverage: "covered" = a scenario states that behaviour; "partial" = a scenario touches it but misses a key part; "missing" = no scenario states it.',
  'UNSUPPORTED = a charter scenario whose expected outcome the ISSUE does not support (invented criteria). Restating or reasonably splitting an issue statement is supported.',
  'Reply with JSON only, no prose, no code fence:',
  '{"tests":[{"test":"<exact test name>","coverage":"covered|partial|missing","scenario":<1-based index or omit>,"why":"..."}],"unsupported":[{"scenario":<1-based index>,"why":"..."}]}',
  'Return one entry per listed test, using the test name exactly. Use an empty "unsupported" array when there is none. With no tests listed, return "tests":[].',
].join('\n');

const renderTests = (tests) => (tests.length
  ? tests.map((x, i) => `### Test ${i + 1}: ${x.test}\n\`\`\`diff\n${x.hunk}\n\`\`\``).join('\n\n')
  : '(none)');

export function buildIssueScopePrompt({ issue, tests }) {
  return [ISSUE_SCOPE_RUBRIC, '', '## ISSUE', issue, '', '## HIDDEN TESTS', renderTests(tests)].join('\n');
}

export function buildIntentJudgePrompt({ issue, charter, tests }) {
  return [INTENT_RUBRIC, '', '## ISSUE', issue, '', '## CHARTER', charter, '', '## HIDDEN TESTS', renderTests(tests)].join('\n');
}

/** The JSON object in a reply: {obj} or {error}. */
function replyObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'judge-error: no JSON object' };
  try { return { obj: JSON.parse(text.slice(start, end + 1)) }; } catch { return { error: 'judge-error: invalid JSON' }; }
}

/** A lookup from an expected test name to its reply entry. A judge can shorten the test path. */
function testFinder(tests) {
  const byName = new Map(tests.map((x) => [x.test, x]));
  return (n) => byName.get(n) ?? tests.find((x) => x.test === n || n.endsWith(x.test) || x.test.endsWith(n) || n.endsWith(`> ${x.test}`));
}

/** Defensive parse. Returns {ok, stated, notStated} or {ok:false, error}. Every expected test must be answered. */
export function parseIssueScope(raw, expected) {
  const { obj, error } = replyObject(raw);
  if (error) return { ok: false, error };
  const tests = obj?.tests;
  if (!Array.isArray(tests) || !tests.every((x) => x && typeof x.test === 'string' && typeof x.inIssue === 'boolean')) return { ok: false, error: 'judge-error: wrong shape' };
  const find = testFinder(tests);
  if (!expected.every((n) => Boolean(find(n)))) return { ok: false, error: 'judge-error: test missing from reply' };
  return { ok: true, stated: expected.filter((n) => find(n).inIssue), notStated: expected.filter((n) => !find(n).inIssue) };
}

/** Defensive parse. Returns {ok, tests, unsupported} or {ok:false, error}. Every expected test must be answered. */
export function parseIntentJudge(raw, expected) {
  const { obj, error } = replyObject(raw);
  if (error) return { ok: false, error };
  const tests = obj?.tests;
  const uns = obj?.unsupported;
  const okTests = Array.isArray(tests) && tests.every((x) => x && typeof x.test === 'string' && CHARTER_COVERAGE.includes(x.coverage));
  const okUns = Array.isArray(uns) && uns.every((x) => x && Number.isInteger(x.scenario));
  if (!okTests || !okUns) return { ok: false, error: 'judge-error: wrong shape' };
  const find = testFinder(tests);
  if (!expected.every((n) => Boolean(find(n)))) return { ok: false, error: 'judge-error: test missing from reply' };
  return { ok: true, tests: expected.map((n) => { const hit = find(n); return { ...hit, test: n, why: String(hit.why ?? '') }; }), unsupported: uns };
}

/** F2P coverage over the issue-stated tests: covered=1, partial=0.5; not-in-issue leaves the denominator. */
export function coverageScore(tests) {
  const c = (k) => tests.filter((t) => t.coverage === k).length;
  const den = c('covered') + c('partial') + c('missing');
  return { covered: c('covered'), partial: c('partial'), missing: c('missing'), notInIssue: c('not-in-issue'), den, pct: den === 0 ? null : (c('covered') + 0.5 * c('partial')) / den };
}

const callJudge = (adapter, { prompt, model, cwd, effort }) => adapter.runHeadless({
  prompt, cwd, model, trustCwd: false, ...(effort ? { effort } : {}),
  tracking: { callSite: 'eval-form-judge', ticketId: null, processRunId: null },
});

const judgeError = (e) => ({ ok: false, error: `judge-error: ${e instanceof Error ? e.message : String(e)}` });

/** Step 1: which tests the issue states. The charter is never an input, so one case gets one answer. */
export async function judgeIssueScope(adapter, { issue, tests, model, cwd, effort }) {
  if (tests.length === 0) return { ok: true, stated: [], notStated: [] };
  const named = (r) => (r.ok ? r : { ok: false, error: r.error.replace('judge-error: ', 'judge-error: issue scope: ') });
  try {
    const res = await callJudge(adapter, { prompt: buildIssueScopePrompt({ issue, tests }), model, cwd, effort });
    return named(parseIssueScope(res.raw, tests.map((t) => t.test)));
  } catch (e) {
    return named(judgeError(e));
  }
}

/** Step 2: score the charter on the stated tests. A failed scope is the judge-error of this attempt, with no charter call. */
export async function judgeIntent(adapter, { issue, charter, tests, scope, model, cwd, effort }) {
  if (!scope.ok) return { ok: false, error: scope.error };
  const stated = tests.filter((t) => scope.stated.includes(t.test));
  try {
    const res = await callJudge(adapter, { prompt: buildIntentJudgePrompt({ issue, charter, tests: stated }), model, cwd, effort });
    const judged = parseIntentJudge(res.raw, stated.map((t) => t.test));
    if (!judged.ok) return judged;
    const byName = new Map(judged.tests.map((t) => [t.test, t]));
    return { ...judged, tests: tests.map(({ test }) => byName.get(test) ?? { test, coverage: 'not-in-issue', why: NOT_STATED_WHY }) };
  } catch (e) {
    return judgeError(e);
  }
}
