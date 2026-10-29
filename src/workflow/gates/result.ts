/**
 * One gate's outcome. Shared, because more than one stage depends on it now:
 * `CommandResult.exitCode` is `number` and cannot express "did not run", which is
 * exactly what a gate whose script the repo never defined has to say.
 */
export interface GateResult {
  name: string;
  /**
   * The gate's exit code, or null when it did not run because the repo does not
   * define its script. Null is not a number the code earned — it means karst had
   * no question to ask, so the gate says nothing about the ticket either way.
   */
  exitCode: number | null;
  output: string;
  /**
   * Set when a `sandbox: host` gate was refused before it could run (sandbox could
   * not start, sync failed, dirty or mismatched host tree). exitCode stays null:
   * no verdict, and the stage parks capability-missing (arch:GATE-CAPABILITY).
   */
  hostRefused?: boolean;
  /**
   * Set when the gate's npm script is missing on the ticket branch but the base
   * defines it: the branch is stale. The stage parks with this reason (no fix
   * round) — a rebase, not a code change, is the repair.
   */
  staleBranch?: string;
  /**
   * Set when the gate was SIGKILLed (exit 137) with no failing test, and the
   * `onResourceKill` policy gave up on it: the park reason. An environment
   * fault, so the stage parks `resource-killed` and consumes no recovery round.
   */
  resourceKilled?: string;
  /**
   * When the gate's process started and ended. Both absent for a gate that never
   * ran — it has no duration, and stamping one would read as a zero-length run
   * rather than as "karst had no question to ask".
   */
  startedAt?: string;
  endedAt?: string;
}
