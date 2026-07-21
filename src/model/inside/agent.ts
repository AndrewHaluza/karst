import type { PhaseMark } from '../../store/phaseMarks.js';
import { FIX_ATTEMPT_CAP } from '../../workflow/fixAttempts.js';
import type { StepperCell } from '../stepper.js';
import {
  formatDuration,
  formatTime,
  inside,
  type OpStatus,
  type StageInside,
  type StageOp,
} from './types.js';

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
function reportedPhases(marks: readonly PhaseMark[], cell: StepperCell): PhaseMark[] {
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
  if (cell.status === 'pending') return inside(cell, now, []);

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
  if (cell.status === 'pending') return inside(cell, now, []);

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
