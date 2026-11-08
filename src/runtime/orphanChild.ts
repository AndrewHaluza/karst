import { parseStartedAt, START_TIME_TOLERANCE_MS, type ProcessFactsSource } from './serverIdentity.js';
import type { KillOutcome } from './processTree.js';

/**
 * The `process_runs` facts an orphan reap decides from (structural, so this
 * runtime module does not import the store).
 */
export interface OrphanChildRun {
  id: number;
  /** The opening HOST's pid — the owner. NULL = unknown. */
  pid: number | null;
  /** The headless child's pid, recorded at spawn. NULL = none recorded. */
  childPid: number | null;
  /** When the child was spawned (ISO). Identity evidence against pid reuse. */
  childStartedAt: string | null;
}

export interface OrphanReapDeps {
  /** Async probes: the reap runs on the driver path, which must not block (no `spawnSync`). */
  facts: Pick<ProcessFactsSource, 'isAlive' | 'processStartMs'>;
  /** `killTree` — signals the child's whole process group. */
  kill: (pid: number) => KillOutcome;
  debug: (message: string) => void;
}

export type OrphanReapOutcome = 'killed' | 'refused';

/**
 * Kill the process group of a headless child whose run was left behind by a
 * dead host (window reload, host crash). A pid is a recollection and the kill
 * hits a whole group, so three checks must ALL hold (the 2026-10-12 incident):
 *
 *  1. a child pid was recorded;
 *  2. the OWNER host pid is known and dead — never a live window's run;
 *  3. the live process is still the recorded child: its own start time matches
 *     the recorded spawn time (as `attributeServer` does for servers) — never
 *     a reused pid.
 *
 * Writes exactly one debug line per call: a kill or a refusal with its reason.
 */
export async function reapOrphanedChild(
  run: OrphanChildRun,
  deps: OrphanReapDeps,
): Promise<OrphanReapOutcome> {
  const label = `[agent] orphan reap: run ${run.id}`;
  const refuse = (reason: string): OrphanReapOutcome => {
    deps.debug(`${label} refused — ${reason}`);
    return 'refused';
  };
  const { childPid } = run;
  if (childPid === null) return refuse('no child pid recorded');
  if (run.pid === null) return refuse('owner host pid unknown');
  if (await deps.facts.isAlive(run.pid)) return refuse(`owner host pid ${run.pid} is alive`);

  if (!(await deps.facts.isAlive(childPid))) return refuse(`child pid ${childPid} already exited`);
  const recorded = parseStartedAt(run.childStartedAt);
  if (recorded === null) return refuse('child spawn time not recorded');
  const live = await deps.facts.processStartMs(childPid);
  if (live === null) return refuse(`child pid ${childPid} start time unreadable`);
  if (Math.abs(live - recorded) > START_TIME_TOLERANCE_MS) {
    return refuse(`child pid ${childPid} was reused (start time differs from the recorded spawn)`);
  }
  const outcome = deps.kill(childPid);
  if (outcome === 'killed') {
    deps.debug(`${label} killed process group of child pid ${childPid} (owner host pid ${run.pid} is dead)`);
    return 'killed';
  }
  return refuse(`kill of child pid ${childPid} was ${outcome}`);
}
