/** Upper bound of a no-change reason, in characters (CLI, MCP and bridge boundary). */
export const NO_CHANGE_MAX_CHARS = 2000;
const END_REASON_MAX_CHARS = 200;
// Control characters except \n (0x0a). A tab becomes a space.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** The agent's no-change reason, made safe to store and to show. Null means no usable reason. */
export function sanitizeNoChangeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\t/gu, ' ').replace(CONTROL, '').trim();
  return clean === '' ? null : clean.slice(0, NO_CHANGE_MAX_CHARS);
}

/**
 * The `end_reason` prefix of a round the host closed because the source stage still failed after
 * its no-change marker: the next fix round opens in the same episode. `previousContinuedRound`
 * and the same-head skip read it back, so the text is a constant, never free-form prose.
 */
export const FIX_CONTINUED_PREFIX = 'gates still fail:';

/** The `end_reason` of a round that closes with a no-change verdict. */
export function noChangeEndReason(reason: string): string {
  const first = (reason.split('\n')[0] ?? '').slice(0, END_REASON_MAX_CHARS);
  return `no change: ${first}`;
}

/** The refusal the bridge CLI gives after it stored a no-change verdict. The bridge then re-runs the gates. */
export const NO_CHANGE_RERUN_PENDING = 'no-change verdict recorded — the host re-runs the failed gates';

/** The host CLI reply after it stored a no-change verdict. The extension sweep re-runs the gates. */
export const NO_CHANGE_RERUN_REQUESTED_REPLY =
  'no-change verdict recorded. The host checks the failed gates and opens the next fix round if they still fail. Stop now: do not make an empty commit and do not fire the marker again.';
