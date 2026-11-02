// Pinned blind judge for the planner bench: issue + drafts vs the hidden gold. Unparsable -> judge-error (excluded, never 0).
import { parseDraftJudge } from './draftJudge.mjs';

export const COVERAGE = ['covered', 'partial', 'none'];
export const PLAN_RUBRIC = [
  'You compare planning DRAFTS (title, description, summary) with the GOLD fix patch for the same issue. The gold is the ground truth for what the work needs.',
  'The drafts are scored as their union: judge all drafts together as one plan.',
  'notDone = work the gold needs that the drafts omit. Name it in item.',
  'unrequested = work the drafts ask for that lies outside the gold scope: name the change, the file and why it is out of scope. Tests and docs the drafts imply are not out of scope.',
  'f2pCoverage = for EACH listed failing-to-passing test: "covered" if the drafts ask for work that would make it pass, "partial" if only some of it, "none" if not.',
  'Do not judge the quality of the prose. You do not know which model wrote the drafts.',
  'verdict = "matches" | "partial" | "diverges".',
  'Reply with JSON only, no prose, no code fence:',
  '{"notDone":[{"item":"..."}],"unrequested":[{"change":"...","file":"...","why":"..."}],"f2pCoverage":[{"test":"...","coverage":"covered|partial|none"}],"verdict":"matches|partial|diverges"}',
  'Use empty arrays when there is nothing to report.',
].join('\n');

export function buildPlanJudgePrompt({ issue, drafts, fixPatch, f2p, testFiles }) {
  const ds = drafts.map((d, i) => `### Draft ${i + 1}\nTitle: ${d.title}\n\nDescription:\n${d.description}\n\nSummary:\n${d.summary}`).join('\n\n');
  return [PLAN_RUBRIC, '', '## ISSUE', issue, '', '## DRAFTS', ds, '', '## GOLD FIX PATCH', fixPatch, '',
    '## F2P TESTS', f2p.map((t) => `- ${t}`).join('\n') || '(none)', '', '## TEST FILES', testFiles.map((f) => `- ${f}`).join('\n') || '(none)'].join('\n');
}

export function parsePlanJudge(raw) {
  const base = parseDraftJudge(raw);
  if (!base.ok) return base;
  const text = String(raw);
  const o = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const cov = o.f2pCoverage;
  if (!Array.isArray(cov) || !cov.every((c) => c && typeof c.test === 'string' && COVERAGE.includes(c.coverage))) return { ok: false, error: 'judge-error: wrong shape' };
  return { ...base, f2pCoverage: cov };
}

export async function judgePlan(adapter, { model, plannerModel, cwd, ...input }) {
  if (model === plannerModel) return { ok: false, error: 'judge-wrote-draft' };
  try {
    const res = await adapter.runHeadless({
      prompt: buildPlanJudgePrompt(input), cwd, model, trustCwd: false,
      tracking: { callSite: 'eval-form-judge', ticketId: null, processRunId: null },
    });
    return { ...parsePlanJudge(res.raw), ...(res.usage ? { usage: res.usage } : {}) };
  } catch (e) {
    return { ok: false, error: `judge-error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
