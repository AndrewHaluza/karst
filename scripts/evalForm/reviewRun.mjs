// Review-findings bench run: the real findings prompt and parser on a seeded git checkout. Strictly sequential.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_OUTPUT_SCHEMA } from '../../src/agent/outputContract.ts';
import { structuredOutputFormOf } from '../../src/agent/surfaces.ts';
import { defaultGitRunner } from '../../src/integrations/git.ts';
import { splitCoverage, stripCoverageLabel } from '../../src/model/coverageRecord.ts';
import { dropDisprovenCheckoutClaims, isWrongCheckoutClaim, verifyCheckout } from '../../src/workflow/review/checkoutClaim.ts';
import { parseFindingsResult } from '../../src/workflow/review/findings.ts';
import { buildFindingsPrompt } from '../../src/workflow/review/findingsLane.ts';

const TIMEOUT = /\btime(d)?[ -]?out\b/i;
const REPO_NAME = 'case-repo';
const BLOCKING_SEVERITY = 'high';
const msg = (e) => (e instanceof Error ? e.message : String(e));
const NEUTRAL = ['-c', 'commit.gpgsign=false', '-c', 'user.name=review-case', '-c', 'user.email=review-case@example.invalid'];
const git = (cwd, ...args) => execFileSync('git', [...NEUTRAL, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Temp git checkout of a case: `repo/base` committed on `main` (message `base`), `repo/change` on top on
 * the case branch (message `change`). A local bare `origin` holds both branches, outside the work tree.
 * Only `repo/` is copied, never `case.json`.
 */
export function buildReviewCheckout(caseDir, caseDef) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'eval-review-')));
  const checkout = join(root, 'checkout');
  const origin = join(root, 'origin.git');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(checkout);
    git(checkout, 'init', '-q', '-b', 'main');
    cpSync(join(caseDir, 'repo', 'base'), checkout, { recursive: true });
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'base');
    git(checkout, 'checkout', '-q', '-b', caseDef.branch);
    if (existsSync(join(caseDir, 'repo', 'change'))) cpSync(join(caseDir, 'repo', 'change'), checkout, { recursive: true });
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'change');
    git(root, 'init', '-q', '--bare', origin);
    git(checkout, 'remote', 'add', 'origin', origin);
    git(checkout, 'push', '-q', 'origin', 'main', caseDef.branch);
  } catch (e) {
    cleanup();
    throw e;
  }
  return { root, checkout, origin, cleanup };
}

const failure = (status, error, seconds) => ({ status, error, findings: [], tier: undefined, shape: undefined, droppedCheckoutClaims: 0, usage: undefined, seconds });

/** Parse, split coverage and drop disproven wrong-checkout claims, all while the checkout still exists. */
async function finalizeFindings({ res, checkout, branch, max, warn, git: gitRunner }) {
  const { findings, shape, tier } = parseFindingsResult(res.raw, { repo: REPO_NAME, worktreePath: checkout, max }, warn, undefined, res.finalMessage);
  const { rest } = splitCoverage(stripCoverageLabel(findings));
  if (!rest.some(isWrongCheckoutClaim)) return { findings: rest, shape, tier, droppedCheckoutClaims: 0 };
  const verdict = await verifyCheckout(gitRunner, checkout, branch);
  const kept = dropDisprovenCheckoutClaims(rest, verdict, { branch, repo: REPO_NAME, warn });
  return { findings: kept, shape, tier, droppedCheckoutClaims: rest.length - kept.length };
}

/** `{status: ok|timeout|error, findings, tier, shape, droppedCheckoutClaims, usage, seconds}`; never throws for a run failure. */
export async function runReviewCase({ adapter, caseDef, caseDir, model, effort, timeoutMs, max, warn = () => {}, git: gitRunner = defaultGitRunner }) {
  const t0 = Date.now();
  const secs = () => (Date.now() - t0) / 1000;
  let work;
  try {
    work = buildReviewCheckout(caseDir, caseDef);
  } catch (e) {
    return failure('error', `checkout: ${msg(e)}`, secs());
  }
  try {
    let res;
    try {
      res = await adapter.runHeadless({
        prompt: buildFindingsPrompt(
          REPO_NAME, caseDef.baseRef, caseDef.branch, undefined, false, null, work.checkout, BLOCKING_SEVERITY,
          undefined, undefined, structuredOutputFormOf(adapter),
        ),
        cwd: work.checkout,
        model,
        ...(effort ? { effort } : {}),
        timeoutMs,
        policy: 'reviewer',
        ...(adapter.surfaces?.structuredOutput?.supported === true ? { outputSchema: REVIEW_OUTPUT_SCHEMA } : {}),
        tracking: { callSite: 'eval-form-review', ticketId: null, processRunId: null },
      });
    } catch (e) {
      return failure(TIMEOUT.test(msg(e)) ? 'timeout' : 'error', msg(e), secs());
    }
    const done = await finalizeFindings({ res, checkout: work.checkout, branch: caseDef.branch, max, warn, git: gitRunner });
    // A reply with no findings container is a failed call, not a clean review. A whole-message `[]` has shape 'empty'.
    if (done.shape === 'unreadable') return failure('error', 'unreadable output: no findings container in the reply', secs());
    return { status: 'ok', ...done, usage: res.usage, seconds: secs() };
  } catch (e) {
    return failure('error', msg(e), secs());
  } finally {
    work.cleanup();
  }
}

/**
 * Run every case `runs` times, strictly one call at a time, case by case. Stops when `maxCalls` calls were made.
 * Returns one record per call: `{caseId, run, ...runReviewCase result}`.
 */
export async function runReviewBench({ adapter, cases, model, effort, timeoutMs, max, runs, maxCalls = Infinity, warn, onProgress, git: gitRunner }) {
  const out = [];
  for (const { dir, def } of cases) {
    for (let run = 1; run <= runs; run++) {
      if (out.length >= maxCalls) return out;
      const res = await runReviewCase({ adapter, caseDef: def, caseDir: dir, model, effort, timeoutMs, max, warn, ...(gitRunner ? { git: gitRunner } : {}) });
      const rec = { caseId: def.id, run, ...res };
      out.push(rec);
      onProgress?.(rec);
    }
  }
  return out;
}
