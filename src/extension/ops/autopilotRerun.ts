import type { Store } from '../../store/db.js';
import { getAutopilotRerun, markAutopilotRerun } from '../../store/autopilot.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { STALE_PATTERN_PREFIX } from '../../workflow/staleGeneratedCi.js';
import { classifyTransientLog, parseCheckUrl, type CheckUrl } from '../../workflow/transientCi.js';

/**
 * Transient CI re-run (T1019, @arch:AP-00): a failed check whose job log shows a network fault gets ONE re-run of the
 * failed jobs of its run, before the allowlist decision. It costs no attempt. gh is reached through injected seams.
 */

/** The gh seams of the re-run. Each throws an Error with a short reason when gh fails. */
export interface TransientCiSeams {
  readonly readJobLog: (cwd: string, check: CheckUrl) => Promise<string>;
  readonly readRunHeadSha: (cwd: string, check: CheckUrl) => Promise<string>;
  readonly rerunFailedJobs: (cwd: string, check: CheckUrl) => Promise<void>;
}

/** After a re-run starts, a rollup that still shows the old failure is not read for this long (gh may lag). */
export const RERUN_SETTLE_MS = 90_000;

/** One failing check of an open PR: where gh runs and which job failed. */
export interface FailedCheck { readonly repo: string; readonly cwd: string; readonly name: string; readonly url: string | null }

export interface RerunContext {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly seams: TransientCiSeams;
  readonly now: () => number;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
}

export type RerunStep =
  /** Nothing to re-run. `earlier` names the checks that were re-run before and failed again. */
  | { readonly kind: 'none'; readonly earlier: ReadonlySet<string> }
  /** A re-run started or has just started: the ticket waits for its result. */
  | { readonly kind: 'rerun' }
  | { readonly kind: 'error'; readonly reason: string };

interface Transient { readonly target: FailedCheck; readonly url: CheckUrl; readonly pattern: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Find the transient failures among the failing checks and re-run them once. */
export async function transientRerunStep(c: RerunContext, fails: readonly FailedCheck[]): Promise<RerunStep> {
  const earlier = new Set<string>();
  const fresh: Array<{ target: FailedCheck; url: CheckUrl }> = [];
  let settling = false;
  for (const target of fails) {
    const url = parseCheckUrl(target.url);
    if (!url) continue;
    const done = getAutopilotRerun(c.store, c.ticketId, target.repo, url.runId, target.name);
    // A rebase round for a stale generated file (T1081) is not a network re-run: it neither settles nor counts as one.
    if (done?.pattern.startsWith(STALE_PATTERN_PREFIX)) continue;
    if (done) {
      earlier.add(target.name);
      if (c.now() - done.rerunAt < RERUN_SETTLE_MS) settling = true;
    } else {
      fresh.push({ target, url });
    }
  }
  if (settling) return { kind: 'rerun' };
  const transient: Transient[] = [];
  for (const f of fresh) {
    // A gh failure here is not "not transient": the result is unknown, so the caller parks.
    let log: string;
    try { log = await c.seams.readJobLog(f.target.cwd, f.url); } catch (err) { return { kind: 'error', reason: messageOf(err) }; }
    const pattern = classifyTransientLog(log);
    if (pattern !== null) transient.push({ ...f, pattern });
  }
  if (transient.length === 0) return { kind: 'none', earlier };
  const runs = new Map<string, Transient[]>();
  for (const t of transient) {
    const k = `${t.target.repo}\0${t.url.runId}`;
    runs.set(k, [...(runs.get(k) ?? []), t]);
  }
  for (const group of runs.values()) {
    const error = await rerunOne(c, group);
    if (error !== null) return { kind: 'error', reason: error };
  }
  return { kind: 'rerun' };
}

/** Re-run the failed jobs of one run. Null on success or when another window already did; else the gh reason. */
async function rerunOne(c: RerunContext, group: readonly Transient[]): Promise<string | null> {
  const first = group[0]!;
  let headSha: string;
  try { headSha = await c.seams.readRunHeadSha(first.target.cwd, first.url); } catch (err) { return messageOf(err); }
  // The marker is written BEFORE gh runs: a reload or a second window that sees it never re-runs the same check again.
  const marked = group.filter((t) => markAutopilotRerun(c.store, c.ticketId, {
    repo: t.target.repo, runId: t.url.runId, checkName: t.target.name, headSha, pattern: t.pattern, rerunAt: c.now(),
  }));
  if (marked.length === 0) return null;
  try { await c.seams.rerunFailedJobs(first.target.cwd, first.url); } catch (err) { return messageOf(err); }
  // The stored rollup shows the failed attempt. Forget it: the ticket waits until the next probe reads the newest run per check (D281).
  clearOpenPrProbe(c.store, c.ticketId, first.target.repo);
  for (const t of marked) {
    const line = `re-ran ${t.target.name} on ${headSha.slice(0, 9)} after a network error (${t.pattern})`;
    c.note(`Autopilot: ${line}`, `${c.key}: ${line} in ${t.target.repo}. It used no attempt.`);
    c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
  }
  return null;
}
