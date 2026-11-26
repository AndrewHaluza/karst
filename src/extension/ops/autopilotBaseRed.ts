import type { Store } from '../../store/db.js';
import { baseRedRuns, baseRedWaitStart, markAutopilotRerun, markBaseRedStopped, markBaseRedWait } from '../../store/autopilot.js';
import type { BaseRedSeams, BaseRun } from '../../integrations/ciRerun.js';
import { BASE_RED_PREFIX, extractFailingTestIds, isBaseRed } from '../../workflow/baseRedCi.js';
import { parseCheckUrl, type CheckUrl } from '../../workflow/transientCi.js';
import { STALE_WAIT_MS } from './autopilotStaleRebase.js';
import type { FailedCheck } from './autopilotRerun.js';

/**
 * Base red (T1383, @arch:AP-12): when EVERY failing check of the open PRs failed on test ids that a failed develop push run of
 * the same job also failed, the failure is not the ticket's. A green develop that the PR does not hold yet gets one Rebase on
 * base per repo; a develop that is still red makes the ticket wait, with no park. No attempt, no agent round, no PR re-run.
 */

/** How long the ticket waits for a red develop on one PR run. Then today's rules apply. */
export const BASE_RED_WAIT_MS = 24 * 60 * 60_000;
/** The failed develop runs whose job log is read per check, newest first. */
export const MAX_BASE_RED_LOGS = 5;

export interface BaseRedContext {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly seams: BaseRedSeams;
  readonly now: () => number;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
}

export type BaseRedStep =
  /** Today's rules apply. `earlier` maps each check that was rebased before and failed again to the base it named. */
  | { readonly kind: 'none'; readonly earlier: ReadonlyMap<string, string> }
  /** A rebase ran, or a rebase of the current run is still in its wait: the ticket waits for the next probe. */
  | { readonly kind: 'rebased' }
  /** Develop is still red with the same ids: no round, no park, no attempt. */
  | { readonly kind: 'waiting' };

interface Proof {
  readonly target: FailedCheck;
  readonly url: CheckUrl;
  readonly base: string;
  readonly prHead: string;
  /** The failed develop run whose ids hold every PR id. */
  readonly red: BaseRun;
  /** The newest completed develop run. */
  readonly newest: BaseRun;
  readonly state: 'green' | 'green-in-head' | 'red';
}

const NONE: BaseRedStep = { kind: 'none', earlier: new Map() };
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function baseRedStep(c: BaseRedContext, fails: readonly FailedCheck[]): Promise<BaseRedStep> {
  const marked = markerState(c, fails);
  if (marked !== null) return marked;
  if (fails.length === 0) return NONE;
  const proofs: Proof[] = [];
  for (const target of fails) {
    const url = parseCheckUrl(target.url);
    if (!url || !target.base) return NONE;
    const since = baseRedWaitStart(c.store, c.ticketId, target.repo, target.name, url.runId);
    if (since !== null && c.now() - since >= BASE_RED_WAIT_MS) return NONE;
    let proof: Proof | null;
    // A gh failure is never base red: today's rules apply, and the transient step reports the error.
    try { proof = await prove(c, target, url, target.base); } catch (err) {
      c.debug(`[ship] autopilot ticket ${c.key} ci: base-red check of ${target.name} not read (${messageOf(err)})`);
      return NONE;
    }
    if (proof === null) return NONE;
    proofs.push(proof);
  }
  if (proofs.some((p) => p.state === 'green-in-head')) return NONE;
  if (proofs.some((p) => p.state === 'red')) {
    for (const p of proofs) if (p.state === 'red') noteWait(c, p);
    return { kind: 'waiting' };
  }
  return rebaseRepos(c, proofs);
}

/** A rebase marker decides alone: on the current run (pushed, inside STALE_WAIT_MS) the ticket waits; on an earlier run, today's rules. */
function markerState(c: BaseRedContext, fails: readonly FailedCheck[]): BaseRedStep | null {
  const earlier = new Map<string, string>();
  let waiting = false;
  for (const f of fails) {
    const runs = baseRedRuns(c.store, c.ticketId, f.repo, f.name);
    if (runs.length === 0) continue;
    const runId = parseCheckUrl(f.url)?.runId ?? '';
    if (runs.some((r) => r.runId === runId && !r.stopped && c.now() - r.rerunAt < STALE_WAIT_MS)) waiting = true;
    else earlier.set(f.name, runs[0]!.base);
  }
  if (earlier.size > 0) return { kind: 'none', earlier };
  return waiting ? { kind: 'rebased' } : null;
}

/** The proof that this check failed the same way on develop, and the state of the newest develop run. Null: not base red. */
async function prove(c: BaseRedContext, target: FailedCheck, url: CheckUrl, base: string): Promise<Proof | null> {
  const prIds = extractFailingTestIds(await c.seams.readJobLog(target.cwd, url));
  if (prIds.length === 0) return null;
  const workflowId = await c.seams.readRunWorkflowId(target.cwd, url);
  const runs = await c.seams.listBaseRuns(target.cwd, url, workflowId, base);
  const newest = runs[0];
  if (newest === undefined) return null;
  let red: BaseRun | null = null;
  for (const r of runs.filter((x) => x.conclusion === 'failure').slice(0, MAX_BASE_RED_LOGS)) {
    const ids = await c.seams.baseRunIds(target.cwd, url, r.runId, target.name);
    if (ids !== null && isBaseRed(prIds, ids)) { red = r; break; }
  }
  if (red === null) return null;
  const prHead = await c.seams.readRunHeadSha(target.cwd, url);
  if (newest.conclusion === 'success') {
    const inHead = await c.seams.commitInHead(target.cwd, url, newest.headSha, prHead);
    return { target, url, base, prHead, red, newest, state: inHead ? 'green-in-head' : 'green' };
  }
  if (newest.conclusion !== 'failure') return null;
  const ids = newest.runId === red.runId ? prIds : await c.seams.baseRunIds(target.cwd, url, newest.runId, target.name);
  return ids !== null && isBaseRed(prIds, ids) ? { target, url, base, prHead, red, newest, state: 'red' } : null;
}

/** One event per (ticket, check, develop run): the wait row of that develop run is the dedup. */
function noteWait(c: BaseRedContext, p: Proof): void {
  const fresh = markBaseRedWait(c.store, c.ticketId, {
    repo: p.target.repo, baseRunId: p.newest.runId, checkName: p.target.name, prRunId: p.url.runId, headSha: p.newest.headSha, at: c.now(),
  });
  if (!fresh) return;
  const line = `waiting for a green ${p.base}: ${p.target.name} fails there too`;
  c.note(`Autopilot: ${line}`, `${c.key}: ${p.target.name} failed in ${p.target.repo} on the same tests as ${p.base} at ${p.newest.headSha.slice(0, 9)}. No round starts and no attempt is used until ${p.base} is green.`);
  c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
}

async function rebaseRepos(c: BaseRedContext, proofs: readonly Proof[]): Promise<BaseRedStep> {
  const repos = new Map<string, Proof[]>();
  for (const p of proofs) repos.set(p.target.repo, [...(repos.get(p.target.repo) ?? []), p]);
  const stopped = new Map<string, string>();
  let done = 0;
  for (const [repo, group] of repos) {
    // The marker is written BEFORE the rebase: a reload or a second window that sees it never rebases the same check again.
    const marked = group.filter((p) => markAutopilotRerun(c.store, c.ticketId, {
      repo, runId: p.url.runId, checkName: p.target.name, headSha: p.prHead, pattern: `${BASE_RED_PREFIX}${p.base}`, rerunAt: c.now(),
    }));
    if (marked.length === 0) continue;
    const pushed = await c.seams.rebase(repo).catch(() => false);
    if (pushed) done += marked.length;
    for (const p of marked) {
      const what = `${p.target.name} failed on ${p.base} too (${p.red.headSha.slice(0, 9)}) and ${p.base} is green at ${p.newest.headSha.slice(0, 9)}`;
      const line = pushed ? `rebased on base: ${what}` : `rebase on base stopped: ${what}`;
      c.note(`Autopilot: ${line}`, `${c.key}: ${line} in ${repo}. It used no attempt.${pushed ? '' : ' Today\'s rules apply.'}`);
      c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
      if (!pushed) {
        stopped.set(p.target.name, p.base);
        markBaseRedStopped(c.store, c.ticketId, repo, p.url.runId, p.target.name);
      }
    }
  }
  return done > 0 ? { kind: 'rebased' } : { kind: 'none', earlier: stopped };
}
