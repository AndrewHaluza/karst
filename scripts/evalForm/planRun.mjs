// Planner bench run: the real planner prompt through adapter.runHeadless, then read the outbox. Strictly sequential.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdPaths, dirtyDefect, planStaticChecks } from './planChecks.mjs';
import { judgePlan } from './planJudge.mjs';
import { gitRunner } from './draftChecks.mjs';

/** Read tools plus ONLY the propose command (pipe and heredoc forms). No bare `node:*`: it would allow `node -e` writes outside the copy. */
export const planTools = (cliEntry) => ['Read', 'Grep', 'Glob', 'Bash(printf:*)', `Bash(node ${cliEntry} draft propose:*)`, 'Bash(node "$KARST_CLI" draft propose:*)'];
const TIMEOUT = /time(d)?[ -]?out/i;
const msg = (e) => (e instanceof Error ? e.message : String(e));

/** Read every `<outbox>/*.json`; keep the LAST file per proposal `id` (mtime, then name), then cap at `maxDrafts`. */
export function readOutbox({ outbox, maxDrafts, validate }) {
  let names = [];
  try { names = readdirSync(outbox).filter((n) => n.endsWith('.json')); } catch { /* no outbox = no draft */ }
  const files = names.map((n) => ({ n, t: statSync(join(outbox, n)).mtimeMs })).sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
  const valid = [];
  const invalid = [];
  for (const { n } of files) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(outbox, n), 'utf8')); } catch { invalid.push(`${n}: not JSON`); continue; }
    const res = validate(raw);
    if (res.ok) valid.push(res.value); else invalid.push(`${n}: ${res.reason}`);
  }
  const lastById = new Map();
  const drafts = [];
  for (const d of valid) {
    if (d.id === undefined) { drafts.push(d); continue; }
    if (lastById.has(d.id)) drafts[drafts.indexOf(lastById.get(d.id))] = d; else drafts.push(d);
    lastById.set(d.id, d);
  }
  return { drafts: drafts.slice(0, maxDrafts), invalid };
}

/** `{status: ok|no-draft|invalid-proposal|timeout|error, drafts, invalid, usage}`; never throws for a run failure. */
export async function runPlannerHeadless({ adapter, instructions, kickoff, checkout, outbox, model, cliEntry, timeoutMs, maxDrafts, validate, effort }) {
  mkdirSync(outbox, { recursive: true });
  let res;
  try {
    res = await adapter.runHeadless({
      prompt: `${instructions}\n\n${kickoff}`, cwd: checkout, model, timeoutMs, trustCwd: true, allowedTools: planTools(cliEntry),
      ...(effort ? { effort } : {}),
      env: { KARST_OUTBOX: outbox, KARST_CLI: cliEntry },
      tracking: { callSite: 'eval-form-plan', ticketId: null, processRunId: null },
    });
  } catch (e) {
    return { status: TIMEOUT.test(msg(e)) ? 'timeout' : 'error', error: msg(e), drafts: [], invalid: [] };
  }
  const { drafts, invalid } = readOutbox({ outbox, maxDrafts, validate });
  const status = drafts.length ? 'ok' : invalid.length ? 'invalid-proposal' : 'no-draft';
  return { status, drafts, invalid, usage: res.usage };
}

/** Fresh checkout copy + scratch dir per run; `cleanup` removes both. */
export function makeWork(item, reposDir) {
  const root = mkdtempSync(join(tmpdir(), 'eval-plan-'));
  const checkout = join(root, 'checkout');
  cpSync(join(reposDir, item.dir), checkout, { recursive: true });
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  return { checkout, scratch, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** items x models, in sequence. Seams: `makeWork`, `buildPrompt(item, work)`, `validate`. */
export async function runPlanEval({ opts, items, models, adapter, judgeAdapter, makeWork: work, buildPrompt, validate, cliEntry, cwd, onProgress = () => {} }) {
  const results = [];
  for (const item of items) {
    for (const model of models) {
      const r = { caseId: item.id, model };
      const w = work(item);
      try {
        const t0 = Date.now();
        const run = await runPlannerHeadless({
          adapter, ...buildPrompt(item, w), checkout: w.checkout, outbox: join(w.scratch, 'outbox'), model, cliEntry,
          timeoutMs: opts.timeoutMin * 60_000, maxDrafts: opts.maxDrafts, validate, effort: opts.effort,
        });
        Object.assign(r, { status: run.status, drafts: run.drafts, invalid: run.invalid, usage: run.usage, seconds: (Date.now() - t0) / 1000 });
        if (run.error) r.error = run.error;
        const git = gitRunner(w.checkout);
        const created = createdPaths(item.fixPatch);
        r.defects = run.drafts.flatMap((d) => planStaticChecks({ git, baseSha: item.baseSha, created, draft: d, knownRepos: [item.repo] }).defects);
        const dirty = dirtyDefect(git);
        if (dirty) r.defects.push(dirty);
        if (run.drafts.length) {
          r.judge = await judgePlan(judgeAdapter, {
            issue: `${item.title}\n\n${item.body}`, drafts: run.drafts, fixPatch: item.fixPatch, testFiles: [...item.testPatch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]),
            f2p: item.f2p, model: opts.judgeModel, effort: opts.judgeEffort, plannerModel: model, cwd,
          });
        }
      } catch (e) { r.status = 'error'; r.error = msg(e); }
      finally { w.cleanup(); }
      results.push(r);
      onProgress(r);
    }
  }
  return results;
}
