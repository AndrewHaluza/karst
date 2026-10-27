/** The time cell of a Sub-tasks row: one short span plus the tooltip that says what it measures. */
export interface SubtaskAge {
  readonly text: string;
  readonly title: string;
}

interface AgeInputs {
  readonly stage: string | null;
  readonly done: boolean;
  readonly fault: { readonly since: string } | null;
  readonly stageSince: string | null;
  readonly queuePos: number | null;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A span in its single largest unit (`45s`, `4m`, `3h`, `2d`); a negative span reads as zero. */
export function spanShort(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MIN) return `${Math.floor(span / SEC)}s`;
  if (span < HOUR) return `${Math.floor(span / MIN)}m`;
  if (span < DAY) return `${Math.floor(span / HOUR)}h`;
  return `${Math.floor(span / DAY)}d`;
}

const since = (iso: string | null, now: number): string | null => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? spanShort(now - at) : null;
}

/** Done reads `Xh ago`, a fault counts from the block, a queued row shows its place, else the time in the stage. */
export function subtaskAge(row: AgeInputs, now: number): SubtaskAge | null {
  if (row.done) {
    const span = since(row.stageSince, now);
    return span ? { text: `${span} ago`, title: `Done ${span} ago` } : null;
  }
  if (row.fault) {
    const span = since(row.fault.since, now);
    return span ? { text: span, title: `Blocked for ${span}` } : null;
  }
  if (row.queuePos !== null) return { text: `#${row.queuePos}`, title: `#${row.queuePos} in the autostart queue` };
  const span = since(row.stageSince, now);
  return span ? { text: span, title: `In ${row.stage ?? 'stage'} for ${span}` } : null;
}
