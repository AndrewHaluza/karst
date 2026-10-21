/**
 * The `kept_outcome` contract of a usage-limit park (D159, K11).
 *
 * A park row carries what the STOPPED lane had already answered: the sibling
 * targets' outcomes and the observations/findings they produced, so a later
 * session can finish the lane's work instead of losing it. ONE vocabulary is
 * shared by both lanes (review, UAT) and by the one-shot re-run:
 *
 * - `usage-limited` — the target whose call hit the quota. The park's subject.
 * - `not-run` — a target the lane NEVER reached: the quota stopped it before
 *   that target was asked. A re-run must ask it, or the verdict it commits
 *   silently omits a repository nobody ever looked at.
 * - the lane's own parse shape (`ok`, `unreadable`, …) — a target that
 *   answered, with its finding/observation count beside it.
 *
 * The shape is opaque JSON: only `targets` (and the lanes' own
 * `observations`/`findings` lists) are read back, and a malformed payload
 * degrades to "nothing kept" — never to a crash.
 */

/** The status that names a target the lane never reached. */
export const NOT_RUN = 'not-run';

/** A target's entry in a park row's `kept_outcome`. */
export interface KeptTarget {
  /** The repository the entry names. */
  repo: string;
  /** The lane's status for it (`not-run`, `usage-limited`, a parse shape…). */
  status?: string;
}

/**
 * The repositories a quota stop never reached, in plan order.
 *
 * The lane asks its targets in order and stops at the first exhausted one, so
 * everything AFTER it in the plan was never asked. Naming them on the park row
 * is what lets a one-shot re-run finish the lane's work: without it, a re-run
 * that asks only the exhausted target commits a verdict that silently omits
 * every repository the lane never covered.
 *
 * `answered` names the targets that already spoke (the lane records each as it
 * lands); `exhausted` is the target whose call hit the quota.
 */
export function notRunRepos(
  targets: readonly { repo: string }[],
  answered: readonly { repo: string }[],
  exhausted: string,
): string[] {
  const seen = new Set([...answered.map((t) => t.repo), exhausted]);
  const repos: string[] = [];
  for (const target of targets) {
    if (seen.has(target.repo)) continue;
    seen.add(target.repo);
    repos.push(target.repo);
  }
  return repos;
}

/**
 * The targets a one-shot re-run must ask: the parked one, plus every target
 * the original lane never reached.
 *
 * A target that already ANSWERED is not asked again — its findings/observations
 * are durable and its `kept_outcome` entry is merged into the re-run's verdict
 * — but a target that never ran has no evidence at all, so asking only the
 * parked one would commit a verdict that silently omits it.
 */
export function laneTargetsToAsk(
  keptTargets: readonly KeptTarget[],
  parked: string,
): string[] {
  const seen = new Set<string>();
  const asked: string[] = [];
  const add = (repo: string): void => {
    if (seen.has(repo)) return;
    seen.add(repo);
    asked.push(repo);
  };
  add(parked);
  for (const target of keptTargets) {
    if (target.status === NOT_RUN) add(target.repo);
  }
  return asked;
}
