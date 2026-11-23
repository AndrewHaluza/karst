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

/** The `end_reason` of a round that closes with a no-change verdict. */
export function noChangeEndReason(reason: string): string {
  const first = (reason.split('\n')[0] ?? '').slice(0, END_REASON_MAX_CHARS);
  return `no change: ${first}`;
}
