// Intent pass loop: raw / improved source modes -> real generateIntent -> checks + judge. Strictly sequential.
import { rmSync } from 'node:fs';
import { checkCharter, countCalls, hunkForTest } from './intentChecks.mjs';
import { judgeIntent, judgeIssueScope } from './intentJudge.mjs';
import { fixedScope } from './issueScope.mjs';

/** Instance (pinned set) -> eval item. testPatch/f2p go ONLY to the judge, never to the agent. */
export function instanceItem({ task, row }) {
  const title = row.resolved_issues?.[0]?.title ?? task.id;
  return { id: task.id, title, type: 'fix', brief: task.brief, f2p: task.f2p, testPatch: task.testPatch, cwdKind: 'empty' };
}

export const caseItem = (c) => ({ id: c.id, title: c.title, type: c.type, brief: c.input, f2p: [], testPatch: '', cwdKind: 'empty' });

/** The form's order (runAnalysis): improve first, then intent with brief + improvedDescription. */
async function charterFor({ mode, item, opts, improve, intent, adapter, cwd }) {
  const counted = countCalls(adapter);
  const effort = opts.effort ? { effort: opts.effort } : {};
  const base = { title: item.title, ticketType: item.type, brief: item.brief, model: opts.model, ...effort };
  if (mode.kind === 'improved') {
    const improved = await improve(adapter, {
      instructions: mode.body ?? '', description: item.brief, title: item.title, ticketType: item.type, cwd, model: opts.model, ...effort,
    });
    base.improvedDescription = improved;
  }
  const result = await intent(counted.adapter, base);
  return { result, calls: counted.state.n, improved: base.improvedDescription };
}

export async function runIntentEval({ opts, items, modes, improve, intent, adapter, judgeAdapter, fixedScopes = null, now = () => Date.now(), makeEmptyDir, onProgress = () => {} }) {
  const attempts = [];
  const scopes = new Map();
  const cwd = makeEmptyDir();
  try {
    for (const mode of modes) {
      for (const item of items) {
        for (let run = 1; run <= opts.runs; run++) {
          const a = { caseId: item.id, source: mode.name, run };
          const t0 = now();
          try {
            const { result, calls, improved } = await charterFor({ mode, item, opts, improve, intent, adapter, cwd });
            a.seconds = (now() - t0) / 1000;
            a.improved = improved;
            a.charter = result.text;
            a.checks = checkCharter({ result, calls, f2p: item.f2p });
            if (result.text !== null) {
              const tests = item.f2p.map((test) => ({ test, hunk: hunkForTest(item.testPatch, test) }));
              const common = { issue: item.brief, tests, model: opts.judgeModel, effort: opts.judgeEffort, cwd };
              const scope = fixedScopes ? fixedScope(fixedScopes, item.id, tests) : scopes.get(item.id) ?? await judgeIssueScope(judgeAdapter, common);
              if (scope.ok) scopes.set(item.id, scope); // a failed scope is not kept: the next charter of the case asks again
              a.judge = await judgeIntent(judgeAdapter, { ...common, charter: result.text, scope });
            }
          } catch (e) {
            a.error = e instanceof Error ? e.message : String(e);
          }
          attempts.push(a);
          onProgress(a);
        }
      }
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  return attempts;
}
