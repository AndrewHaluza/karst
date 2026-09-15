/**
 * How many times karst will auto-resume the agent into `fix` after a gate fails
 * before it parks the ticket and hands it back to the human. Without a cap, a
 * ticket the agent cannot fix would re-loop fix→uat/review→fix forever — `fix`
 * returns to whichever gate failed it, so either loop needs the same backstop.
 *
 * Lives alone so the driver (which enforces it) and the dashboard copy (which
 * reports "attempt 2 of 3") can never disagree about the number.
 */
export const FIX_ATTEMPT_CAP = 3;

/**
 * The gate stages that carry their own fix budget. `ship` is here because a
 * human team's unresolved PR review feedback opens a real recovery round
 * (`src/workflow/prFeedbackFix.ts`), exactly as a failed gate does; that round's
 * committed `max_rounds` is what bounds it. `graph.ts`'s `GATE_STAGES` is a
 * different list with different consumers and is deliberately NOT widened.
 */
const GATE_STAGE_KEYS = ['uat', 'review', 'ship'] as const;
export type GateStageKey = (typeof GATE_STAGE_KEYS)[number];

/**
 * How many times ONE gate has failed this ticket — the depth of that gate's fix
 * loop.
 *
 * Per stage, not summed. `stages.attempt` was always per `(ticket_id, stage_key)`,
 * but the policy read here summed uat + review into one counter: two review
 * failures left UAT a single attempt for a budget it had never spent. With `fix`
 * returning to `uat`, both gates fail on the same ticket routinely, so the sum
 * exhausts roughly twice as fast as either budget says.
 *
 * The `fix` stage's own `attempt` is always 0 — the machine bumps the stage that
 * FAILED, and fix is only ever passed through.
 */
export function countFixAttempts(
  stages: readonly { stageKey: string; attempt?: number }[],
  stageKey: GateStageKey,
): number {
  return stages.find((s) => s.stageKey === stageKey)?.attempt ?? 0;
}

/**
 * Which gate sent this ticket to `fix` — the one whose budget the resume spends.
 *
 * By latest `endedAt`, not by array order: the stage rows have no ordering
 * contract, and `attempt` cannot break the tie because it only climbs on failure,
 * so a fail-then-pass pair sits at the same number.
 */
export function lastFailedGate(
  stages: readonly { stageKey: string; status?: string; endedAt?: string | null }[],
): GateStageKey | null {
  const failed = stages.filter(
    (s): s is { stageKey: GateStageKey; status?: string; endedAt?: string | null } =>
      s.status === 'failed' && (GATE_STAGE_KEYS as readonly string[]).includes(s.stageKey),
  );
  if (failed.length === 0) return null;
  return failed.reduce((latest, s) =>
    (s.endedAt ?? '') > (latest.endedAt ?? '') ? s : latest,
  ).stageKey;
}

/**
 * The fix budget for ONE gate. Each gate's budget is its own manifest key —
 * `uat.maxFixAttempts` can never narrow a gate it does not name, nor
 * `review.maxFixAttempts` uat's — and an unconfigured gate keeps the default.
 *
 * Extracted from `fixResumeDecision` so the driver (which SPENDS the budget) and
 * the rail's retry meter (which draws one tick per allowed attempt) resolve the
 * same number. A meter with more ticks than the driver will spend is a lie about
 * how many retries are left, which is the one thing the meter exists to say.
 */
export function capForGate(gate: GateStageKey, uatMax?: number, reviewMax?: number): number {
  if (gate === 'uat') return uatMax ?? FIX_ATTEMPT_CAP;
  if (gate === 'review') return reviewMax ?? FIX_ATTEMPT_CAP;
  // `ship` is upstream review feedback. It has no manifest knob of its own —
  // `review.maxFixAttempts` narrows karst's review lane and must not silently
  // narrow a human team's — so it takes the default.
  return FIX_ATTEMPT_CAP;
}

/**
 * True while the ticket still has an auto-resume left after `attempts` failures.
 * `cap` is caller-supplied so each gate can honour its own manifest override —
 * `uat.maxFixAttempts` for uat, `review.maxFixAttempts` for review
 * (`driveTicket.ts`'s `fixResumeDecision`) — falling back to `FIX_ATTEMPT_CAP`
 * when neither is configured.
 */
export function fixAttemptsRemain(attempts: number, cap: number = FIX_ATTEMPT_CAP): boolean {
  return attempts < cap;
}

/**
 * v30: the driver's fix decision for a ticket with a COMMITTED recovery round.
 *
 * The round is the source of truth for both the attempt number (its `round`)
 * and the budget (its committed `max_rounds`): the manifest knob may have
 * changed since the failure was committed, and must not retroactively widen or
 * narrow a round already in flight — `recoveryDecision` reads the snapshot
 * back from the store, never from the live manifest.
 */
export type RoundFixDecision =
  | { kind: 'resume'; roundId: number; attempts: number }
  | { kind: 'exhausted'; roundId: number; attempts: number; cap: number };

export function roundFixDecision(round: {
  roundId: number;
  round: number;
  maxRounds: number;
}): RoundFixDecision {
  return fixAttemptsRemain(round.round, round.maxRounds)
    ? { kind: 'resume', roundId: round.roundId, attempts: round.round }
    : { kind: 'exhausted', roundId: round.roundId, attempts: round.round, cap: round.maxRounds };
}
