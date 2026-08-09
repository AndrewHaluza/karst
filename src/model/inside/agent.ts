import type { AgentProvider } from '../../manifest/types.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import { PROVIDER_INTERACTIVE_USAGE } from '../../agent/provider.js';
import type { ImplementationSegment, ImplementationTimeline } from '../../store/implementationRuns.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import type { StepperCell } from '../stepper.js';
import { AGENT_PROVIDER_LABELS } from '../agentIdentity.js';
import { formatExactTokens, formatTokens } from '../tokenFormat.js';
import {
  formatDuration,
  formatTime,
  type AgentExecutionView,
  type EvidenceRow,
  type InsideEvidenceTarget,
  type InsideProcessView,
  type InsideStatus,
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

export interface SessionView {
  sessionId: string | null;
  agentState: string | null;
  model: string | null;
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

/** Cap on timeline rows before the remainder row takes over. */
const TIMELINE_LIMIT = 20;

/** Measured token totals for the session process; null when nothing was measured. */
export interface SessionTokensInput {
  /** Total measured tokens across the implementation. */
  total: number;
  /** Count of calls whose numbers are estimates, not reports. */
  estimatedCalls?: number;
  /** Measured input tokens, when the record splits directions. */
  input?: number;
  /** Measured output tokens, when the record splits directions. */
  output?: number;
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
 *
 * Every row carries a structural `role` (Task 4): the run start and every
 * switch/resume are `identity` segments (a switch/resume also carries its own
 * `provider` key so the webview can draw the injected core icon beside the
 * row's own identity prose), phase marks are `phase` with the prototype's
 * `reported · <time>` detail, and the remainder row is a generic `event`.
 * The webview keys off `role`/`connector` — never off label prose.
 */
/**
 * One segment's MEASURED total, as the reducer consumes it. A structural
 * subset of the store's `SegmentTokenTotals` (`readSegmentTokenTotals`), so a
 * caller with a partial row still type-checks and the reducer stays pure.
 * Only segments that HAVE a measured total appear — an absent segment is
 * absence, and a fabricated zero would read as a measured free segment.
 */
export interface SegmentTokensInput {
  implementationSegmentId: number;
  total: number;
}

function timelineEvents(
  timeline: ImplementationTimeline,
  marks: readonly PhaseMark[],
  now: string,
  segmentTokens: readonly SegmentTokensInput[],
): TimelineEvent[] {
  // The switch row states what the segment it moved TO went on to spend.
  const totalBySegment = new Map(
    segmentTokens.filter((s) => s.total > 0).map((s) => [s.implementationSegmentId, s.total]),
  );
  const events: TimelineEvent[] = [];
  const { run, segments } = timeline;

  events.push({
    at: run.startedAt,
    row: {
      status: 'note',
      label: 'started',
      detail: formatTime(run.startedAt),
      duration: formatDuration(run.startedAt, run.endedAt ?? now),
      // The run start names the session's identity segment. Its prose is
      // only the start time, so it carries no provider key — an icon beside
      // a timestamp would claim an identity the row does not state.
      role: 'identity',
    },
  });

  // The first segment's start IS the run start — the row above covers both.
  for (const segment of segments) {
    if (!segment.startedAt) continue;
    if (segment.reason !== 'switch' && segment.reason !== 'resume') continue;
    const view = executionView(segment.provider, segment.model);
    const measured = totalBySegment.get(segment.id);
    events.push({
      at: segment.startedAt,
      row: {
        // The segment's OWN measured spend, when the ledger attributed any to
        // it. Absent → no pill: this reducer never claims a segment cost
        // nothing, only that nothing was recorded for it.
        ...(measured !== undefined
          ? { tokens: tokenView({ total: measured }, measuresSessionUsage(segment.provider)) }
          : {}),
        // A switch is not progress: it carries no status node beyond the
        // shared note. Only the provider/model it moved to is stated. The
        // connector is STRUCTURAL — the webview draws the relationship arrow
        // from it, never from parsing `label`.
        status: 'note',
        label: segment.reason === 'switch' ? 'switch' : 'resumed',
        detail: `${view.providerLabel} · ${view.modelLabel}`,
        connector: segment.reason,
        role: 'identity',
        // The row's OWN provider key (the injected core icon beside its
        // identity prose) — never the process's latest segment identity.
        provider: segment.provider,
      },
    });
  }

  for (const mark of marks) {
    if (mark.stageKey !== 'impl') continue;
    if (mark.implementationRunId !== null && mark.implementationRunId !== run.id) continue;
    events.push({
      at: mark.markedAt,
      row: {
        status: 'note',
        label: mark.phaseName,
        // The prototype's acceptance copy: the phase name first, the report
        // stamp second. Ships pre-worded so the webview renders it verbatim.
        detail: `reported · ${formatTime(mark.markedAt)}`,
        role: 'phase',
      },
    });
  }

  // The terminal row exists ONLY when the end is recorded: the impl marker is
  // an explicit act (`completeImplementationRun` stamps `ended_at` AND passes
  // the run), so `pass` is the recorded verdict — never an inference. A
  // running session has no end and is not given one.
  if (run.endedAt) {
    events.push({
      at: run.endedAt,
      row: {
        status: 'pass',
        label: 'done',
        detail: `implementation marked done · ${formatTime(run.endedAt)}`,
        role: 'phase',
      },
    });
  }

  // Stable sort: ties keep insertion order (start, then segments, then marks
  // by id — the record of what karst was told).
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

/** The title shown when a provider can never produce a per-session usage fact. */
const UNAVAILABLE_TOKEN_TITLE = 'Token usage not available for this provider';

/**
 * Whether a provider's interactive sessions can produce measured usage facts.
 * The capability table in `agent/provider.ts` is the single source — consumed
 * here, never re-derived. A provider absent from the table is not claimed
 * unmeasurable: absence is not evidence it reports nothing.
 */
function measuresSessionUsage(provider: string | null | undefined): boolean {
  if (!provider) return true;
  return PROVIDER_INTERACTIVE_USAGE[provider as AgentProvider] ?? true;
}

/**
 * Measured token totals as the shared display view — reused by every AI
 * process. A provider that reports no per-session usage renders UNAVAILABLE,
 * never a zero: absence is a first-class state (decision 8). The capability
 * defaults to true so callers without one (headless gate processes, whose
 * usage is recorded per call, not per session) keep their measured reading.
 */
export function tokenView(tokens: SessionTokensInput, interactiveUsage = true): TokenUsageView {
  if (!interactiveUsage) {
    return { state: 'unavailable', title: UNAVAILABLE_TOKEN_TITLE };
  }
  return {
    state: (tokens.estimatedCalls ?? 0) > 0 ? 'estimated' : 'measured',
    total: formatTokens(tokens.total),
    exact: formatExactTokens(tokens.total),
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
 * The visible status copy per inside status — the textual channel beside the
 * glyph, keyed by the SAME `InsideStatus` union `sessionStatus` produces, so
 * the row's status and its label can never disagree. Exhaustive by type: a
 * status added to the union has no label until this record grows a key.
 */
export const SESSION_STATUS_LABELS: Readonly<Record<InsideStatus, string>> = {
  pending: 'Pending',
  run: 'Running',
  wait: 'Waiting',
  pass: 'Completed',
  fail: 'Failed',
  note: 'Note',
  skip: 'Skipped',
};

/** The rule copy naming the session's only advance condition. */
const EXPLICIT_MARKER_COPY = 'advances only on explicit done marker';

/** The rule copy for a run that actually switched providers. */
const CONTINUITY_COPY = 'same session continues across switches';

/**
 * The session's recorded facts as footer lines, in plan order: session id,
 * switch count, input/output totals, continuity claim, explicit-marker rule.
 *
 * Every item is omitted when its fact was not recorded — a session id no
 * segment confirmed, a run with no switch, a token record without a
 * per-direction split. The split renders only when BOTH directions were
 * recorded and non-zero: `0 input` would read as a measured free side. The
 * continuity claim is conditional on a recorded switch so it never asserts a
 * continuity that did not happen; the explicit-marker rule is the stage's own
 * contract and always closes the footer.
 */
function implementationFooter(
  timeline: ImplementationTimeline | null,
  tokens: SessionTokensInput | null | undefined,
): readonly string[] {
  if (!timeline) return [];
  const items: string[] = [];

  // The session identity is the FIRST confirmed segment's provider session id
  // — the session the run was opened with. A launch that never confirmed
  // recorded none.
  for (const segment of timeline.segments) {
    if (segment.status !== 'pending' && segment.providerSessionId) {
      items.push(`session ${segment.providerSessionId}`);
      break;
    }
  }

  const switches = timeline.segments.filter((s) => s.reason === 'switch').length;
  if (switches > 0) items.push(`${switches} switch${switches === 1 ? '' : 'es'}`);

  if (
    tokens &&
    tokens.input !== undefined &&
    tokens.output !== undefined &&
    tokens.input > 0 &&
    tokens.output > 0
  ) {
    items.push(`${formatTokens(tokens.input)} input · ${formatTokens(tokens.output)} output`);
  }

  if (switches > 0) items.push(CONTINUITY_COPY);
  items.push(EXPLICIT_MARKER_COPY);
  return items;
}

/**
 * The impl stage's `session` process: the stable run's timeline (Task 10).
 *
 * The timeline is a LOG — every reported phase event stays, repeats included,
 * in the order it happened — which is exactly what separates it from
 * `reportedPhases` (one row per phase, first mark). The recorded segments are
 * the execution; the configured identity is shown only until a recorded
 * execution exists — a launch-prepared run's pending segment is timeline
 * evidence, not execution, so the configured identity stays during that window.
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
  segmentTokens: readonly SegmentTokensInput[] = [],
): InsideProcessView {
  const execution = timeline ? latestConfirmedSegment(timeline) : undefined;

  let rows: readonly EvidenceRow[] = [];
  let withheld = 0;
  if (timeline) {
    const boundedRows = bounded(
      timelineEvents(timeline, marks, now, segmentTokens).map((e) => e.row),
      TIMELINE_LIMIT,
    );
    rows = boundedRows.shown;
    withheld = boundedRows.remaining;
    if (boundedRows.remaining > 0) {
      rows = [
        ...rows,
        {
          status: 'note',
          label: 'more',
          detail: `+${boundedRows.remaining} more`,
          role: 'event',
        },
      ];
    }
  }

  // The process row can open the stable run's full evidence — the one action a
  // timeline row cannot carry without claiming a specific segment. It exists
  // ONLY when the timeline was actually cut short: with nothing withheld the
  // disclosure already shows every row, so a "Show all" beside it offered a
  // second, weaker way to see what was on screen.
  const action =
    attach && timeline && withheld > 0
      ? attach({
          kind: 'open-full-evidence',
          processRunId: timeline.run.processRunId,
          label: `Show ${withheld} more`,
        })
      : undefined;

  // Per-session usage exists only for providers whose bridge emits measured
  // UsageUpdate events (agent/provider.ts) — a Claude/Antigravity session can
  // never produce a token fact, so the row renders absence-with-title, NEVER
  // "0 tokens". The capability belongs to the provider: what RAN decides, and
  // the configured provider speaks before anything ran.
  const interactiveUsage = measuresSessionUsage(execution?.provider ?? configured?.provider);
  const tokensView: TokenUsageView | undefined = tokens
    ? tokenView(tokens, interactiveUsage)
    : interactiveUsage
      ? undefined
      : { state: 'unavailable', title: UNAVAILABLE_TOKEN_TITLE };

  // One status reading feeds both the row's dot and its label — a second
  // derivation from `cell` is how the two would drift apart.
  const status = sessionStatus(cell);
  const footer = implementationFooter(timeline, tokens);

  return {
    id: 'session',
    kind: 'session',
    label: 'Session',
    status,
    statusLabel: SESSION_STATUS_LABELS[status],
    ...(footer.length > 0 ? { footer } : {}),
    ...(action ? { action } : {}),
    ...(cell.startedAt ? { duration: formatDuration(cell.startedAt, cell.endedAt ?? now) } : {}),
    ...(execution ? { execution: executionView(execution.provider, execution.model) } : {}),
    ...(configured && !execution
      ? { configuredExecution: executionView(configured.provider, configured.model) }
      : {}),
    ...(tokensView ? { tokens: tokensView } : {}),
    evidence: { kind: 'timeline', rows },
  };
}
