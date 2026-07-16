/**
 * How many times karst will auto-resume the agent into `fix` after a gate fails
 * before it parks the ticket and hands it back to the human. Without a cap, a
 * ticket the agent cannot fix would re-loop fix→review→fix forever.
 *
 * Lives alone so the driver (which enforces it) and the dashboard copy (which
 * reports "attempt 2 of 3") can never disagree about the number.
 */
export const FIX_ATTEMPT_CAP = 3;

/**
 * How many times a gate has failed this ticket — the depth of the fix loop.
 *
 * The `fix` stage's own `attempt` is always 0: the machine bumps `attempt` on the
 * stage that FAILED (uat/review), and fix is only ever passed through. So the
 * loop count is the gates' failures, summed.
 */
export function countFixAttempts(
  stages: readonly { stageKey: string; attempt?: number }[],
): number {
  return stages
    .filter((s) => s.stageKey === 'uat' || s.stageKey === 'review')
    .reduce((total, s) => total + (s.attempt ?? 0), 0);
}

/** True while the ticket still has an auto-resume left after `attempts` failures. */
export function fixAttemptsRemain(attempts: number): boolean {
  return attempts < FIX_ATTEMPT_CAP;
}
