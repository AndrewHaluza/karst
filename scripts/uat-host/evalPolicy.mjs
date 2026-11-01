// Eval unattended-pipeline policy (@arch:UATHOST-04): where a no-human run
// ends and how every human gate is resolved. Pure data + one classifier; the
// runner (D293) reads `classifyEnd`, scoring never does.

/** The ticket ENTERING ship with every earlier stage passed. Ship never runs. */
export const TERMINAL_STAGE = 'ship';

/** Blocked kinds a run must never be left waiting on (Resume refuses them). */
export const USER_DECIDED_KINDS = ['awaiting-impl-marker', 'baseline-review'];

/** Gate table: each human gate and its deliberate eval resolution. */
export const GATE_TABLE = [
  { gate: 'pending-confirm', where: 'ship entry', resolution: 'terminal', detail: 'ship parks pending; the click is never given — this IS the terminal point' },
  { gate: 'awaiting-impl-marker', where: 'graph impl', resolution: 'not-raised', detail: 'overlay declares no graph approach' },
  { gate: 'baseline-review', where: 'uat', resolution: 'not-raised', detail: 'overlay omits uat.baselineReview' },
  { gate: 'boot-failed', where: 'uat services', resolution: 'blocked', detail: 'out of scope, recorded' },
  { gate: 'capability-missing', where: 'review', resolution: 'blocked', detail: 'out of scope, recorded' },
  { gate: 'awaiting-merge', where: 'ship', resolution: 'unreachable', detail: 'inside ship' },
  { gate: 'stopServersOnDone', where: 'done', resolution: 'unreachable', detail: 'done never reached' },
];

/** Keys the eval overlay must never carry (they raise USER_DECIDED_KINDS). */
export const FORBIDDEN_OVERLAY_KEYS = ['approaches', 'baselineReview'];

/** True when overlay manifest text declares a key that raises a user-decided gate. */
export function overlayRaisesUserGate(manifestText) {
  return FORBIDDEN_OVERLAY_KEYS.some((k) => new RegExp(`^\\s*${k}:`, 'm').test(manifestText));
}

/** A task repo with no declared command gate is skipped and recorded, never a pass. */
export function commandGateRecord(gates) {
  return gates.length === 0
    ? [{ gate: 'uat', status: 'skipped', reason: 'no-command' }]
    : gates.map((g) => ({ gate: g.name, status: 'declared' }));
}

/**
 * Classify how a run ended from the ticket's stage rows.
 * `terminal` = ship entered, all earlier stages passed/bypassed.
 * `blocked`/`timeout`/`failed` carry {stage, blockedKind, reason} and are
 * reported separately from test failure.
 */
export function classifyEnd({ stageCurrent, stages, timedOut = false }) {
  const row = stages.find((s) => s.stageKey === stageCurrent);
  const base = { stage: stageCurrent, blockedKind: row?.blockedKind ?? null, reason: row?.blockedReason ?? null };
  if (stageCurrent === TERMINAL_STAGE && row?.status === 'pending') {
    const earlier = stages.filter((s) => s.stageKey !== TERMINAL_STAGE);
    if (earlier.every((s) => s.status === 'passed' || s.status === 'bypassed')) {
      return { outcome: 'terminal', ...base };
    }
  }
  if (row?.blockedKind) return { outcome: 'blocked', ...base };
  if (timedOut) return { outcome: 'timeout', ...base };
  return { outcome: row?.status === 'failed' ? 'failed' : 'incomplete', ...base };
}
