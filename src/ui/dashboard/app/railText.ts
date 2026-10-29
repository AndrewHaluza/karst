/**
 * The words and shapes of the stage rail, kept apart from the components. Everything here is a pure
 * function of what the host sent: the webview never derives a verdict (UI-R31), it only names one.
 */
import type { DashboardState } from '../state.js';

export type RailSeg = DashboardState['rail']['main'][number];
export type Approach = NonNullable<DashboardState['approach']>;
export type Retry = NonNullable<RailSeg['retry']>;

/** The human title of a stage; also the Inside block's. */
export const STAGE_TITLE: Readonly<Record<string, string>> = {
  uat: 'UAT',
  review: 'Review',
  fix: 'Fix',
  scope: 'Scope',
  impl: 'Implementation',
  ship: 'Ship',
  done: 'Done',
};

/** The strip's headline for a block: shared by the blocked banner and the sub-task rows, so they never drift. */
export function blockFaultTitle(kind: string, stageKey: string): string {
  if (kind === 'usage-limit') return 'Provider out of quota';
  if (kind === 'resource-killed') return 'Gate ran out of memory';
  if (kind === 'review-stalled') return 'Review is stalled';
  return `${STAGE_TITLE[stageKey] ?? stageKey} is blocked`;
}

/**
 * Stage status to segment class. Needs-you is NOT here: it OUTRANKS the stage status and comes from the
 * segment's own `needsUser`, which the host derives once for every surface. `pending` is a real class: the
 * segment's own rule sets no colour, so an untravelled segment would otherwise wear its stage hue at full strength.
 */
const SEG_CLASS: Readonly<Record<string, string>> = {
  passed: 'passed',
  running: 'running',
  failed: 'failed',
  pending: 'pending',
  skipped: 'skipped',
  blocked: 'blocked',
  paused: 'blocked',
  bypassed: 'bypassed',
};

/** Running is a spinner ELEMENT (see `.spin`), so it has no character here. */
const SEG_GLYPH: Readonly<Record<string, string>> = {
  passed: '✓',
  failed: '✕',
  pending: '·',
  skipped: '–',
  blocked: '❚❚',
  paused: '❚❚',
  bypassed: '⊘',
};

/** A parked confirm stage carries a pause; a conflicted merge a warning. Two glyphs, ONE state. */
const NEEDS_GLYPH = '❚❚';
const CONFLICT_GLYPH = '⚠';
/** A stage parked on a fault the banner explains: the attention triangle, never the running spinner. */
export const FAULT_GLYPH = CONFLICT_GLYPH;

export interface SegLook {
  readonly status: string;
  readonly needs: boolean;
  readonly running: boolean;
  /** The segment's status/needs class (empty for a status the rail does not know). */
  readonly statusClass: string;
  /** A character glyph; empty while `running` (a spinner element is drawn instead) or for an unknown status. */
  readonly glyph: string;
  readonly title: string;
}

export function look(s: RailSeg): SegLook {
  const k = s.cell.stageKey;
  // The HOST resolves how the cell reads (displayStatus): a parked stage keeps its stored `running`.
  const status = s.status || s.cell.status;
  const needs = s.needsUser === true;
  // A conflict is a WORDING difference, not a new state: merge has no failed edge.
  const conflict = needs && s.needs?.action === 'Resolve';
  const running = status === 'running' || !!s.retry?.live;
  return {
    status,
    needs,
    running,
    statusClass: needs ? 'needs' : (SEG_CLASS[status] ?? ''),
    glyph: running ? '' : conflict ? CONFLICT_GLYPH : needs ? NEEDS_GLYPH : (SEG_GLYPH[status] ?? ''),
    title: STAGE_TITLE[k] ?? k,
  };
}

/** Under a rail node there is room for one number, not a sentence. */
export function durationText(cell: { readonly startedAt?: string; readonly endedAt?: string }): string {
  if (!cell.startedAt || !cell.endedAt) return '';
  const ms = new Date(cell.endedAt).getTime() - new Date(cell.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * ", 3 of 4 phases reported", or nothing when the approach declares no workflow ("0 of 0" counts something
 * that does not exist). Counted against the DECLARED phases, so a stale mark cannot push the tally past its total.
 */
export function phaseProgress(approach: Approach): string {
  const phases = approach.phases ?? [];
  if (!phases.length) return '';
  const done = new Set(approach.reported ?? []);
  return `, ${phases.filter((p) => done.has(p)).length} of ${phases.length} phases reported`;
}

/** impl's approach is drawn in impl's own segment, only while the ticket is there and not waiting on the user. */
export const showsApproach = (s: RailSeg, approach: Approach | null): approach is Approach =>
  s.current && s.cell.stageKey === 'impl' && s.needsUser !== true && !!approach;

/**
 * The accessible name carries everything the narrow steps drop: the status, the approach (the pips and their
 * caption are its only visual form), the retry loop and its return target.
 */
export function segAria(s: RailSeg, approach: Approach | null): string {
  const l = look(s);
  const r = s.retry;
  return (
    (l.needs ? `${l.title}: needs you` : `${l.title}: ${l.status}`) +
    (showsApproach(s, approach) ? ` — approach ${approach.id}${phaseProgress(approach)}` : '') +
    (r ? ` — fix ${r.spent}/${r.cap}${r.live ? ' running' : ''}` : '') +
    (r?.returnsTo ? `, revalidates from ${r.returnsTo}` : '')
  );
}

export const meterLabel = (r: Retry): string =>
  `Fix loop on ${STAGE_TITLE[r.gate] ?? r.gate}: attempt ${r.spent} of ${r.cap}${r.live ? ', running' : ''}`;

/** What clicking the needs-you control does, from the host's closed `cta` union. */
export function ctaOf(s: RailSeg): NonNullable<RailSeg['needs']>['cta'] | null {
  return s.needs?.cta ?? null;
}
