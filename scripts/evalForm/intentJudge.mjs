// Pinned LLM judge for the intent pass. Sees issue + charter + per F2P test its name and test_patch hunk.
// Unparsable -> judge-error (counted, excluded, never 0).

export const COVERAGE = ['covered', 'partial', 'missing', 'not-in-issue'];

export const INTENT_RUBRIC = [
  'You audit a black-box test charter written from a ticket (ISSUE). For each hidden test (name + test hunk) decide whether the CHARTER covers the behaviour the test checks.',
  'Count only behaviour the ISSUE itself states. If a test checks something the ISSUE never mentions, answer "not-in-issue" (the charter cannot be expected to know it).',
  'coverage: "covered" = a scenario states that behaviour; "partial" = a scenario touches it but misses a key part; "missing" = the issue states it but no scenario does.',
  'UNSUPPORTED = a charter scenario whose expected outcome the ISSUE does not support (invented criteria). Restating or reasonably splitting an issue statement is supported.',
  'Reply with JSON only, no prose, no code fence:',
  '{"tests":[{"test":"<exact test name>","coverage":"covered|partial|missing|not-in-issue","scenario":<1-based index or omit>,"why":"..."}],"unsupported":[{"scenario":<1-based index>,"why":"..."}]}',
  'Return one entry per listed test, using the test name exactly. Use an empty "unsupported" array when there is none. With no tests listed, return "tests":[].',
].join('\n');

export function buildIntentJudgePrompt({ issue, charter, tests }) {
  const t = tests.length
    ? tests.map((x, i) => `### Test ${i + 1}: ${x.test}\n\`\`\`diff\n${x.hunk}\n\`\`\``).join('\n\n')
    : '(none)';
  return [INTENT_RUBRIC, '', '## ISSUE', issue, '', '## CHARTER', charter, '', '## HIDDEN TESTS', t].join('\n');
}

/** Defensive parse. Returns {ok, tests, unsupported} or {ok:false, error}. Every expected test must be answered. */
export function parseIntentJudge(raw, expected) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'judge-error: no JSON object' };
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'judge-error: invalid JSON' }; }
  const tests = obj?.tests;
  const uns = obj?.unsupported;
  const okTests = Array.isArray(tests) && tests.every((x) => x && typeof x.test === 'string' && COVERAGE.includes(x.coverage));
  const okUns = Array.isArray(uns) && uns.every((x) => x && Number.isInteger(x.scenario));
  if (!okTests || !okUns) return { ok: false, error: 'judge-error: wrong shape' };
  const byName = new Map(tests.map((x) => [x.test, x]));
  if (!expected.every((n) => byName.has(n))) return { ok: false, error: 'judge-error: test missing from reply' };
  return { ok: true, tests: expected.map((n) => ({ ...byName.get(n), why: String(byName.get(n).why ?? '') })), unsupported: uns };
}

/** F2P coverage over the issue-stated tests: covered=1, partial=0.5; not-in-issue leaves the denominator. */
export function coverageScore(tests) {
  const c = (k) => tests.filter((t) => t.coverage === k).length;
  const den = c('covered') + c('partial') + c('missing');
  return { covered: c('covered'), partial: c('partial'), missing: c('missing'), notInIssue: c('not-in-issue'), den, pct: den === 0 ? null : (c('covered') + 0.5 * c('partial')) / den };
}

export async function judgeIntent(adapter, { issue, charter, tests, model, cwd }) {
  try {
    const res = await adapter.runHeadless({
      prompt: buildIntentJudgePrompt({ issue, charter, tests }), cwd, model, trustCwd: false,
      tracking: { callSite: 'eval-form-judge', ticketId: null, processRunId: null },
    });
    return parseIntentJudge(res.raw, tests.map((t) => t.test));
  } catch (e) {
    return { ok: false, error: `judge-error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
