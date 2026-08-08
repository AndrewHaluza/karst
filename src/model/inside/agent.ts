import type { AgentProvider } from '../../manifest/types.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import type { ImplementationSegment, ImplementationTimeline } from '../../store/implementationRuns.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import { FIX_ATTEMPT_CAP } from '../../workflow/fixAttempts.js';
import type { StepperCell } from '../stepper.js';
import { AGENT_PROVIDER_LABELS } from '../agentIdentity.js';
import { formatExactTokens, formatTokens } from '../tokenFormat.js';
import {
  formatDuration,
  formatTime,
  inside,
  type AgentExecutionView,
  type EvidenceRow,
  type InsideEvidenceTarget,
  type InsideProcessView,
  type InsideStatus,
  type OpStatus,
  type StageInside,
  type StageOp,
  type TokenUsageView,
  type TypedInsideAction,
} from './types.js';
import { bounded } from './bounds.js';

/**
 * The agent stages. Neither impl nor fix produces a deterministic sub-signal —
 * that is the architecture, not a gap — so everything here either reports the
 * session karst can see or states the rule it is waiting on. Nothing in this
 * file may infer progress from the agent's behaviour.
 *
 * The one thing it MAY show is a phase the agent reported by running a marker
 * command: that is a fact with a timestamp, the same class of evidence as the
 * impl done marker. The absence of such a mark stays evidence of nothing —
 * never "not done", never "skipped", only "not reported".
 */

/** The prompt `runFix` actually resumes the session with. */
const FIX_PROMPT = 'Address the failing review gates, then stop.';

export interface SessionView {
  sessionId: string | null;
  agentState: string | null;
  model: string | null;
}

/** How the captured session reads right now. */
function agentStatus(agentState: string | null, cellStatus: string): OpStatus {
  if (cellStatus === 'passed') return 'pass';
  if (agentState === 'waiting') return 'wait';
  if (agentState === 'running') return 'run';
  // idle/none on a live stage: karst can see a session but not work in it.
  return 'note';
}

function agentOp(
  session: SessionView,
  cellStatus: string,
  describe: (id: string) => string,
): StageOp {
  if (!session.sessionId) {
    return {
      status: 'note',
      name: 'agent',
      detail: 'no session captured for this ticket yet',
      duration: '',
    };
  }
  return {
    status: agentStatus(session.agentState, cellStatus),
    name: 'agent',
    detail: describe(session.sessionId),
    duration: '',
  };
}

/**
 * The marks this render is entitled to use: this stage, this attempt, each
 * phase at its FIRST mark.
 *
 * Selected explicitly by `stageKey` and `attempt`, and ordered by `id` — never
 * by array position. `listPhaseMarks` returns every mark a ticket ever recorded,
 * ungrouped, and no query contract promises the order they arrive in; leaning on
 * it would couple two components by an assumption neither asserts (see `3e21e5c`,
 * the same bug in the gate-run batch selector). `id` is the rowid alias, so
 * insertion order IS report order, and that is a property of the data.
 *
 * A phase reported twice renders once, at its first mark: approaches loop
 * legitimately (research → plan → research), and a repeat counter would make
 * ordinary iteration read as thrashing.
 */
export function reportedPhases(marks: readonly PhaseMark[], cell: StepperCell): PhaseMark[] {
  const attempt = cell.attempt ?? 0;
  const mine = marks.filter((m) => m.stageKey === cell.stageKey && m.attempt === attempt);
  const first = new Map<string, PhaseMark>();
  for (const m of [...mine].sort((a, b) => a.id - b.id)) {
    if (!first.has(m.phaseName)) first.set(m.phaseName, m);
  }
  return [...first.values()];
}

/**
 * What karst was told, in the order it was told it, plus one row naming the
 * declared phases it was told nothing about.
 *
 * The unreported phases share a single row deliberately. A row each would put
 * declared-but-unobserved phases back on the strip as steps, which is the
 * fabrication the row-count guarantee exists to prevent — the reader would see a
 * checklist and read the blanks as failures.
 */
function reportedRows(reported: readonly PhaseMark[], phases: readonly string[]): StageOp[] {
  const declared = new Set(phases);
  const rows = reported.map((m): StageOp => {
    const when = `reported ${formatTime(m.markedAt)}`;
    return declared.has(m.phaseName)
      ? { status: 'pass', name: m.phaseName, detail: when, duration: '' }
      : {
          status: 'note',
          name: m.phaseName,
          detail: `${when} · not in this approach's workflow`,
          duration: '',
        };
  });

  const seen = new Set(reported.map((m) => m.phaseName));
  const unreported = phases.filter((p) => !seen.has(p));
  if (unreported.length === 0) return rows;

  return [
    ...rows,
    {
      status: 'note',
      name: 'not reported',
      detail: unreported.join(' → '),
      duration: '',
    },
  ];
}

/**
 * The declared-only rows: what impl showed before phase marks existed, and what
 * it still shows when nothing was reported.
 */
function declaredRows(phases: readonly string[]): StageOp[] {
  return [
    // Declared, never observed. One row for the whole list: a row per phase
    // would read as a checklist karst is ticking off, and it is not.
    {
      status: 'note',
      name: 'phases',
      detail: phases.length
        ? phases.join(' → ')
        : 'this approach declares no workflow — impl is one undivided stage',
      duration: '',
    },
    {
      status: 'note',
      name: 'recorded',
      detail: 'karst records no per-phase state — the agent runs these itself inside impl',
      duration: '',
    },
  ];
}

export function implInside(
  cell: StepperCell,
  session: SessionView,
  /** The approach's DECLARED workflow phase names. */
  phases: readonly string[],
  /** Every phase mark on the ticket — filtered to this stage/attempt here. */
  marks: readonly PhaseMark[],
  now: string,
): StageInside {
  // The approach's declared workflow phases are static config, known before
  // impl ever starts — the same class of fact as a gate's spec list — so a
  // not-yet-started impl shows them too (declaredRows, `note`-status: declared,
  // never observed), instead of blurb.
  const elapsed = formatDuration(cell.startedAt, cell.endedAt ?? now);
  const agent = agentOp(session, cell.status, (id) =>
    session.model ? `session ${id} — ${session.model}` : `session ${id}`,
  );

  const reported = reportedPhases(marks, cell);

  return inside(cell, now, [
    { ...agent, duration: elapsed },
    {
      status: 'note',
      name: 'driver',
      detail: 'impl advances only on the explicit done marker — a session ending is not a verdict',
      duration: '',
    },
    ...(reported.length === 0 ? declaredRows(phases) : reportedRows(reported, phases)),
  ]);
}

export function fixInside(
  cell: StepperCell,
  sessionId: string | null,
  fixAttempts: number,
  now: string,
): StageInside {
  // Where fix returns to, and how many attempts remain, is static config —
  // known before the fix loop is ever entered — so pending shows it too.
  const left = Math.max(FIX_ATTEMPT_CAP - fixAttempts, 0);
  const remaining =
    left === 0 ? 'no attempts left' : `${left} attempt${left === 1 ? '' : 's'} left`;

  const agent = agentOp(
    { sessionId, agentState: cell.status === 'running' ? 'running' : null, model: null },
    cell.status,
    (id) => `resumed session ${id} — "${FIX_PROMPT}"`,
  );

  return inside(cell, now, [
    { ...agent, duration: formatDuration(cell.startedAt, cell.endedAt ?? now) },
    {
      status: 'note',
      name: 'returns',
      detail: `re-enters the review gate on pass — ${remaining}`,
      duration: '',
    },
  ]);
}

/** Cap on timeline rows before the remainder row takes over. */
const TIMELINE_LIMIT = 20;

/** Measured token totals for the session process; null when nothing was measured. */
export interface SessionTokensInput {
  /** Total measured tokens across the implementation. */
  total: number;
  /** Count of calls whose numbers are estimates, not reports. */
  estimatedCalls?: number;
}

/** The provider/model karst was configured to run, shown before any segment. */
export interface SessionConfiguredInput {
  provider: string;
  model: string | null;
}

/** The provider label — the shared brand identity, with the webview's fallback. */
export function labelForProvider(provider: string): string {
  const labels = AGENT_PROVIDER_LABELS as Readonly<Record<string, string | undefined>>;
  return labels[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** The model label — the bundled catalog's, else the raw id, else the default reading. */
export function labelForModel(provider: string, model: string | null): string {
  if (!model) return 'Agent default';
  const catalog = bundledModelCatalog()[provider as AgentProvider];
  return catalog?.find((option) => option.id === model)?.label ?? model;
}

/** One recorded provider session as the display model. */
export function executionView(provider: string, model: string | null): AgentExecutionView {
  return {
    provider,
    providerLabel: labelForProvider(provider),
    model,
    modelLabel: labelForModel(provider, model),
  };
}

/** The latest segment that a provider session actually confirmed. */
function latestConfirmedSegment(
  timeline: ImplementationTimeline,
): ImplementationSegment | undefined {
  for (let i = timeline.segments.length - 1; i >= 0; i -= 1) {
    const segment = timeline.segments[i];
    if (segment && segment.status !== 'pending') return segment;
  }
  return undefined;
}

/** One event the timeline can sort: every row carries the moment it happened. */
interface TimelineEvent {
  at: string;
  row: EvidenceRow;
}

/**
 * The session's chronology: the run start, every switch/resume segment, and
 * every impl phase mark, one row each, ordered by when they happened.
 *
 * A phase mark attributed to a DIFFERENT run belongs to another
 * implementation and is dropped; a legacy mark (never attributed) predates
 * run attribution and stays — it is still this ticket's impl evidence. A
 * segment with no start never confirmed a launch, so it is not an event yet.
 */
function timelineEvents(
  timeline: ImplementationTimeline,
  marks: readonly PhaseMark[],
  now: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const { run, segments } = timeline;

  events.push({
    at: run.startedAt,
    row: {
      status: 'note',
      label: 'started',
      detail: formatTime(run.startedAt),
      duration: formatDuration(run.startedAt, run.endedAt ?? now),
    },
  });

  // The first segment's start IS the run start — the row above covers both.
  for (const segment of segments) {
    if (!segment.startedAt) continue;
    if (segment.reason !== 'switch' && segment.reason !== 'resume') continue;
    const view = executionView(segment.provider, segment.model);
    events.push({
      at: segment.startedAt,
      row: {
        // A switch is not progress: it carries no status node beyond the
        // shared note. Only the provider/model it moved to is stated.
        status: 'note',
        label: segment.reason === 'switch' ? 'switch' : 'resumed',
        detail: `${view.providerLabel} · ${view.modelLabel}`,
      },
    });
  }

  for (const mark of marks) {
    if (mark.stageKey !== 'impl') continue;
    if (mark.implementationRunId !== null && mark.implementationRunId !== run.id) continue;
    events.push({
      at: mark.markedAt,
      row: { status: 'note', label: mark.phaseName, detail: formatTime(mark.markedAt) },
    });
  }

  // Stable sort: ties keep insertion order (start, then segments, then marks
  // by id — the record of what karst was told).
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

/** Measured token totals as the shared display view — reused by every AI process. */
export function tokenView(tokens: SessionTokensInput): TokenUsageView {
  return {
    total: formatTokens(tokens.total),
    exact: formatExactTokens(tokens.total),
    estimated: (tokens.estimatedCalls ?? 0) > 0,
  };
}

function sessionStatus(cell: StepperCell): InsideStatus {
  switch (cell.status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'running':
      return 'run';
    case 'skipped':
      return 'skip';
    default:
      return 'pending';
  }
}

/**
 * The impl stage's `session` process: the stable run's timeline (Task 10).
 *
 * The timeline is a LOG — every reported phase event stays, repeats included,
 * in the order it happened — which is exactly what separates it from
 * `reportedPhases` (one row per phase, first mark). The recorded segments are
 * the execution; the configured identity is shown only before anything ran.
 * Measured tokens are stated when they exist and OMITTED otherwise — a zero
 * would read as a measured free call.
 */
export function implementationSessionProcess(
  cell: StepperCell,
  timeline: ImplementationTimeline | null,
  marks: readonly PhaseMark[],
  configured: SessionConfiguredInput | null | undefined,
  tokens: SessionTokensInput | null | undefined,
  now: string,
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined,
): InsideProcessView {
  const execution = timeline ? latestConfirmedSegment(timeline) : undefined;

  let rows: readonly EvidenceRow[] = [];
  if (timeline) {
    const boundedRows = bounded(
      timelineEvents(timeline, marks, now).map((e) => e.row),
      TIMELINE_LIMIT,
    );
    rows = boundedRows.shown;
    if (boundedRows.remaining > 0) {
      rows = [
        ...rows,
        { status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` },
      ];
    }
  }

  // The process row itself can open the stable run's full evidence — the one
  // action a timeline row cannot carry without claiming a specific segment.
  const action = attach && timeline ? attach({ kind: 'open-full-evidence', processRunId: timeline.run.processRunId }) : undefined;

  return {
    id: 'session',
    kind: 'session',
    label: 'Session',
    status: sessionStatus(cell),
    ...(action ? { action } : {}),
    ...(cell.startedAt ? { duration: formatDuration(cell.startedAt, cell.endedAt ?? now) } : {}),
    ...(execution ? { execution: executionView(execution.provider, execution.model) } : {}),
    ...(!timeline && configured
      ? { configuredExecution: executionView(configured.provider, configured.model) }
      : {}),
    ...(tokens ? { tokens: tokenView(tokens) } : {}),
    evidence: { kind: 'timeline', rows },
  };
}
