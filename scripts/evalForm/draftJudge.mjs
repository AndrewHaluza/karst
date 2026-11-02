// Pinned judge for the draft pass: draft text + landed diff. Unparsable -> judge-error (excluded, never 0).
export const DRAFT_RUBRIC = [
  'You compare a planning DRAFT (title, description, summary, constraints) with the DIFF that landed for it. The diff is the ground truth.',
  'notDone = something the draft explicitly asked for that the diff does not do. Quote the draft text in draftQuote.',
  'unrequested = a change in the diff the draft did not ask for (scope drift): name the change, the file and why it is not asked for.',
  'NOT drift: tests, docs and arch-doc updates the draft implies; fixes made for review or CI findings. If you can tell a change is such a fix, list it in reviewFix instead of unrequested.',
  'Do not judge the quality of the draft prose. A truncated or dropped file list entry is still part of the diff: judge by what you can see and do not report what you cannot see.',
  'verdict = "matches" | "partial" | "diverges".',
  'Reply with JSON only, no prose, no code fence:',
  '{"notDone":[{"item":"...","draftQuote":"..."}],"unrequested":[{"change":"...","file":"...","why":"..."}],"reviewFix":[{"change":"...","file":"..."}],"verdict":"matches|partial|diverges"}',
  'Use empty arrays when there is nothing to report.',
].join('\n');

export const VERDICTS = ['matches', 'partial', 'diverges'];

export function buildDraftJudgePrompt({ draft, files, diff }) {
  const list = files.map((f) => `${f.status}\t${f.path}`).join('\n');
  const c = (draft.constraints ?? []).map((x) => `- ${x}`).join('\n') || '(none)';
  return [DRAFT_RUBRIC, '', '## DRAFT', `Title: ${draft.title}`, '', 'Description:', draft.description ?? '', '', 'Summary:', draft.summary ?? '', '', 'Constraints:', c,
    '', '## FILES', list, '', '## DIFF', diff].join('\n');
}

const isStr = (v) => typeof v === 'string';
export function parseDraftJudge(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'judge-error: no JSON object' };
  let o;
  try { o = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'judge-error: invalid JSON' }; }
  const arr = (v, pred) => Array.isArray(v) && v.every((e) => e && pred(e));
  const reviewFix = o?.reviewFix === undefined ? [] : o.reviewFix;
  if (!arr(o?.notDone, (e) => isStr(e.item)) || !arr(o?.unrequested, (e) => isStr(e.change)) || !arr(reviewFix, (e) => isStr(e.change)) || !VERDICTS.includes(o?.verdict)) {
    return { ok: false, error: 'judge-error: wrong shape' };
  }
  return { ok: true, notDone: o.notDone, unrequested: o.unrequested, reviewFix, verdict: o.verdict };
}

export async function judgeDraft(adapter, { draft, files, diff, model, cwd }) {
  try {
    const res = await adapter.runHeadless({
      prompt: buildDraftJudgePrompt({ draft, files, diff }), cwd, model, trustCwd: false,
      tracking: { callSite: 'eval-form-judge', ticketId: null, processRunId: null },
    });
    return parseDraftJudge(res.raw);
  } catch (e) {
    return { ok: false, error: `judge-error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
