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
   * When the gate's process started and ended. Both absent for a gate that never
   * ran — it has no duration, and stamping one would read as a zero-length run
   * rather than as "karst had no question to ask".
   */
  startedAt?: string;
  endedAt?: string;
}
