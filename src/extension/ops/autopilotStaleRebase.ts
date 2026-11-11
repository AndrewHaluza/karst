import type { Store } from '../../store/db.js';
import { hasStaleRebase, markAutopilotRerun } from '../../store/autopilot.js';
import { classifyStaleGeneratedLog, STALE_PATTERN_PREFIX } from '../../workflow/staleGeneratedCi.js';
import { parseCheckUrl, type CheckUrl } from '../../workflow/transientCi.js';
import type { FailedCheck } from './autopilotRerun.js';

/**
 * Stale generated file in CI (T1081, @arch:AP-05): when EVERY failing check of the open PRs failed only on
 * `<path> is stale: run <command>` (a command of `ship.regenerate`), the host runs Rebase on base once, with no confirm prompt.
 * It uses no attempt and no agent. The marker row (`autopilot_reruns`, pattern `stale-generated:<command>`) is written before the rebase.
 */

export interface StaleRebaseSeams {
  readonly readJobLog: (cwd: string, check: CheckUrl) => Promise<string>;
  readonly readRunHeadSha: (cwd: string, check: CheckUrl) => Promise<string>;
  /** The `ship.regenerate` commands of a repository. */
  readonly regenerate: (repo: string) => readonly string[];
  /** Rebase on base for one repo, with no confirm prompt. True only when it pushed; every refusal of the op gives false. */
  readonly rebase: (repo: string) => Promise<boolean>;
}

export interface StaleRebaseContext {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly seams: StaleRebaseSeams;
  readonly now: () => number;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
}

export type StaleStep =
  /** Today's rules apply. `earlier` names the checks that were rebased before and failed again. */
  | { readonly kind: 'none'; readonly earlier: ReadonlySet<string> }
  /** A rebase ran (or another window started it): the ticket waits for the next probe. */
  | { readonly kind: 'rebased' };

interface Stale { readonly target: FailedCheck; readonly url: CheckUrl; readonly command: string }

export async function staleRebaseStep(c: StaleRebaseContext, fails: readonly FailedCheck[]): Promise<StaleStep> {
  const earlier = new Set(fails.filter((f) => hasStaleRebase(c.store, c.ticketId, f.repo, f.name)).map((f) => f.name));
  const none: StaleStep = { kind: 'none', earlier };
  if (fails.length === 0 || earlier.size > 0) return none;
  const stale: Stale[] = [];
  for (const target of fails) {
    const url = parseCheckUrl(target.url);
    if (!url) return none;
    // A gh failure here is not "stale": the transient step reads the same log and reports the error.
    let log: string;
    try { log = await c.seams.readJobLog(target.cwd, url); } catch { return none; }
    const commands = classifyStaleGeneratedLog(log, c.seams.regenerate(target.repo));
    if (commands === null) return none;
    stale.push({ target, url, command: commands.join('; ') });
  }
  const repos = new Map<string, Stale[]>();
  for (const s of stale) repos.set(s.target.repo, [...(repos.get(s.target.repo) ?? []), s]);
  const stopped = new Set<string>();
  // A check that has a marker for the same run (a network re-run) is not rebased: today's rules handle it, so it counts as not done.
  let done = 0;
  for (const [repo, group] of repos) {
    const first = group[0]!;
    let headSha: string;
    // A failed read skips this repo only: a repo that already pushed keeps the ticket waiting.
    try { headSha = await c.seams.readRunHeadSha(first.target.cwd, first.url); } catch { continue; }
    // The marker is written BEFORE the rebase: a reload or a second window that sees it never rebases the same check again.
    const marked = group.filter((s) => markAutopilotRerun(c.store, c.ticketId, {
      repo, runId: s.url.runId, checkName: s.target.name, headSha, pattern: `${STALE_PATTERN_PREFIX}${s.command}`, rerunAt: c.now(),
    }));
    if (marked.length === 0) continue;
    const pushed = await c.seams.rebase(repo).catch(() => false);
    if (pushed) done += marked.length;
    for (const s of marked) {
      const line = pushed
        ? `rebased on base for ${s.command} after ${s.target.name} failed on ${headSha.slice(0, 9)}`
        : `rebase on base stopped for ${s.command} after ${s.target.name} failed on ${headSha.slice(0, 9)}`;
      c.note(`Autopilot: ${line}`, `${c.key}: ${line} in ${repo}. It used no attempt.${pushed ? '' : ' Today\'s rules apply.'}`);
      c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
      if (!pushed) stopped.add(s.target.name);
    }
  }
  // A repo that pushed forgot its rollup: the ticket waits. When no repo pushed, today's rules apply.
  // `earlier` names only the checks whose rebase stopped: a check that a network re-run marked was never rebased.
  return done === 0 ? { kind: 'none', earlier: stopped } : { kind: 'rebased' };
}
