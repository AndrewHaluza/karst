import { deleteAutopilotRerun, getAutopilotRerun, getCiRoundHeadSha, markAutopilotRerun, setCiRoundHeadSha } from '../../store/autopilot.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { parseCheckUrl, type CheckUrl } from '../../workflow/transientCi.js';
import { NO_CHANGE_PATTERN, RERUN_SETTLE_MS, type FailedCheck, type RerunContext } from './autopilotRerun.js';
import { STALE_PATTERN_PREFIX } from '../../workflow/staleGeneratedCi.js';

export { NO_CHANGE_PATTERN };

/**
 * A CI round that made no commit (D564, @arch:AP-03): when a failing check still shows the head SHA that was recorded when the
 * last CI round was sent, no commit came and CI cannot change. The failed jobs of that run are re-run ONCE, at no attempt cost
 * (marker `no-change` in `autopilot_reruns`, written before gh runs). A second failure on the same head parks the ticket.
 */

export type NoChangeStep =
  | { readonly kind: 'none' }
  /** A re-run started or is settling: the ticket waits for its result. */
  | { readonly kind: 'rerun' }
  /** The check failed again on the same head after the one re-run: the caller parks. */
  | { readonly kind: 'stopped'; readonly check: string }
  | { readonly kind: 'error'; readonly reason: string };

interface Candidate { readonly target: FailedCheck; readonly url: CheckUrl; readonly headSha: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Record the head SHA of the failing run for each repo, when a CI round is sent. A gh failure records nothing (the step then never fires). */
export async function recordCiRoundHeads(c: RerunContext, fails: readonly FailedCheck[]): Promise<void> {
  const seen = new Set<string>();
  for (const f of fails) {
    const url = parseCheckUrl(f.url);
    if (!url || seen.has(f.repo)) continue;
    seen.add(f.repo);
    try {
      setCiRoundHeadSha(c.store, c.ticketId, f.repo, await c.seams.readRunHeadSha(f.cwd, url));
    } catch (err) {
      c.debug(`[ship] autopilot ticket ${c.key} ci: the head of the failing run of ${f.repo} was not recorded (${messageOf(err)})`);
    }
  }
}

/** Find the failing checks whose run head equals the recorded head, and re-run them once or report that the re-run failed again. */
export async function noChangeStep(c: RerunContext, fails: readonly FailedCheck[]): Promise<NoChangeStep> {
  const fresh: Candidate[] = [];
  let settling = false;
  let stopped: string | null = null;
  for (const target of fails) {
    const url = parseCheckUrl(target.url);
    const recorded = getCiRoundHeadSha(c.store, c.ticketId, target.repo);
    if (!url || recorded === null) continue;
    const done = getAutopilotRerun(c.store, c.ticketId, target.repo, url.runId, target.name);
    // A stale rebase pushed a new head, so its marker belongs to its own step. A network re-run marker on this run means the one
    // re-run of this run is used: on an unchanged head the check is not re-run again, and it stops once the re-run has settled.
    if (done?.pattern.startsWith(STALE_PATTERN_PREFIX)) continue;
    let headSha: string;
    try { headSha = await c.seams.readRunHeadSha(target.cwd, url); } catch (err) { return { kind: 'error', reason: messageOf(err) }; }
    if (headSha !== recorded) continue;
    if (!done) fresh.push({ target, url, headSha });
    else if (c.now() - done.rerunAt < RERUN_SETTLE_MS) settling = true;
    else stopped ??= target.name;
  }
  if (settling) return { kind: 'rerun' };
  if (stopped !== null) return { kind: 'stopped', check: stopped };
  if (fresh.length === 0) return { kind: 'none' };
  const runs = new Map<string, Candidate[]>();
  for (const f of fresh) {
    const k = `${f.target.repo}\0${f.url.runId}`;
    runs.set(k, [...(runs.get(k) ?? []), f]);
  }
  for (const group of runs.values()) {
    const error = await rerunOnce(c, group);
    if (error !== null) return { kind: 'error', reason: error };
  }
  return { kind: 'rerun' };
}

/** Re-run the failed jobs of one run. Null on success or when another window already did; else the gh reason. */
async function rerunOnce(c: RerunContext, group: readonly Candidate[]): Promise<string | null> {
  const first = group[0]!;
  // The marker is written BEFORE gh runs: a reload or a second window that sees it never re-runs the same check again.
  const marked = group.filter((f) => markAutopilotRerun(c.store, c.ticketId, {
    repo: f.target.repo, runId: f.url.runId, checkName: f.target.name, headSha: f.headSha, pattern: NO_CHANGE_PATTERN, rerunAt: c.now(),
  }));
  if (marked.length === 0) return null;
  try {
    await c.seams.rerunFailedJobs(first.target.cwd, first.url);
  } catch (err) {
    // gh refused: no re-run happened, so the marker must not say one did (a Retry would park as if it failed again).
    for (const f of marked) deleteAutopilotRerun(c.store, c.ticketId, f.target.repo, f.url.runId, f.target.name);
    return messageOf(err);
  }
  // The stored rollup shows the failed attempt: forget it, so the ticket waits for the next probe (D281).
  clearOpenPrProbe(c.store, c.ticketId, first.target.repo);
  for (const f of marked) {
    const sha = f.headSha.slice(0, 9);
    const line = `${f.target.name} ${sha} re-run once: the ci round made no commit`;
    c.note(`Autopilot: ${line}`, `${c.key}: ${line} in ${f.target.repo}. It used no attempt.`);
    c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
  }
  return null;
}
