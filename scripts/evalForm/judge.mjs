// Pinned LLM judge: source + output only, JSON {lost, invented}. Unparsable -> judge-error (excluded, never 0).

export const JUDGE_RUBRIC = [
  'You audit a rewrite of a ticket description. You see only the SOURCE and the OUTPUT.',
  'LOST = a requirement or fact stated in the SOURCE that is missing from the OUTPUT.',
  'INVENTED = acceptance criteria, root cause, scope or metric in the OUTPUT that the SOURCE does not support.',
  'Rewording, shortening and restructuring are NOT lost or invented. A `**Note:**` line flagging unrelated or embedded text is NOT invented.',
  'Reply with JSON only, no prose, no code fence:',
  '{"lost":[{"item":"...","sourceQuote":"..."}],"invented":[{"item":"...","outputQuote":"..."}]}',
  'Use empty arrays when there is nothing to report.',
].join('\n');

export function buildJudgePrompt(source, output) {
  return [JUDGE_RUBRIC, '', '## SOURCE', source, '', '## OUTPUT', output].join('\n');
}

const validList = (v, quoteKey) =>
  Array.isArray(v) && v.every((e) => e && typeof e.item === 'string' && (e[quoteKey] === undefined || typeof e[quoteKey] === 'string'));

/** Defensive parse: tolerate fences/prose around one JSON object. Returns {ok, lost, invented} or {ok:false, error}. */
export function parseJudge(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'judge-error: no JSON object' };
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'judge-error: invalid JSON' }; }
  if (!validList(obj?.lost, 'sourceQuote') || !validList(obj?.invented, 'outputQuote')) {
    return { ok: false, error: 'judge-error: wrong shape' };
  }
  return { ok: true, lost: obj.lost, invented: obj.invented };
}

/** Run the judge via an adapter. Never throws: an adapter failure is a judge-error too. */
export async function judgeOutput(adapter, { source, output, model, cwd }) {
  try {
    const res = await adapter.runHeadless({
      prompt: buildJudgePrompt(source, output), cwd, model, trustCwd: false,
      tracking: { callSite: 'eval-form-judge', ticketId: null, processRunId: null },
    });
    return parseJudge(res.raw);
  } catch (e) {
    return { ok: false, error: `judge-error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
