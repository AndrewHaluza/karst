import type { StageKey } from '../types.js';
import type { StepperCell } from '../stepper.js';

/**
 * How an operation row reads.
 *
 * `note` is not a status. It is karst stating a fact it cannot honestly dress as
 * a pass or a fail — a gate the repo cannot answer, a phase karst does not
 * observe, a rule about what will happen next. Keeping it in the union is what
 * stops the panel inventing a verdict to fill a row.
 *
 * `skip` is narrower and is NOT a second `note`: the gate exists, the repository
 * can answer it, and a human decided it should not be asked for this ticket. A
 * `note` says karst had no question; a `skip` says the question was withdrawn,
 * and a reader who cannot tell the two apart cannot tell a broken repo from a
 * deliberate choice.
 */
export type OpStatus = 'pass' | 'fail' | 'run' | 'wait' | 'pending' | 'note' | 'skip';

/** One line inside a stage: what karst did, or plainly why it cannot say. */
export interface StageOp {
  status: OpStatus;
  /** Short left-hand name — `lint`, `worktree`, `agent`. */
  name: string;
  /** The machine detail — `npm run lint — exit 1`. */
  detail: string;
  /** Preformatted duration, or '' when there is none to state. */
  duration: string;
}

/** The state dot beside the "Inside <stage>" header. */
export type InsideDot = 'done' | 'run' | 'wait' | 'fail' | 'idle' | 'pend';

/** Everything the activity strip renders for ONE stage. A snapshot, no functions. */
export interface StageInside {
  stageKey: StageKey;
  /** Display title — `Implementation`, `UAT`. */
  title: string;
  dot: InsideDot;
  /** `12:23:06 · 51.7s · attempt 1`, or `has not run yet`. */
  clock: string;
  /**
   * Observed rows. EMPTY means nothing ran — the view shows `blurb` instead.
   * Empty rows would imply karst tried something and got nothing back.
   */
  ops: StageOp[];
  /** The static "what happens here" copy. Always present. */
  blurb: string;
}

/** Display titles for the strip header. */
export const STAGE_TITLES: Readonly<Record<StageKey, string>> = {
  scope: 'Scope',
  impl: 'Implementation',
  uat: 'UAT',
  review: 'Review',
  fix: 'Fix',
  ship: 'Ship',
  done: 'Done',
};

/**
 * What each stage does, taken from the runners in `src/workflow/stages/`. This
 * is what a not-yet-run stage shows, so selecting a pending stage still answers
 * "what will happen here?" rather than showing an empty panel.
 */
export const STAGE_BLURBS: Readonly<Record<StageKey, string>> = {
  scope:
    'Validates the hot repo set against the manifest, then creates one worktree per hot repo off the baseline branch. Nothing is created until you confirm.',
  impl: 'The interactive agent session. Advances only on the explicit done marker — a session ending is not a verdict.',
  uat: "Runs the repo's own test script in the ticket's worktree. The exit code is the verdict; nothing self-reported counts.",
  review:
    'Runs lint, typecheck and test. Every gate the repo can answer must exit 0. The diff opens for you either way.',
  fix: 'Resumes the captured session so the agent keeps its context, then re-enters the uat gate.',
  ship:
    'Commits, pushes, and opens one PR per hot repo with an agent-written description, then waits until every one of them is merged. karst never merges on its own — you click Merge on each PR, or a teammate lands it and the PR sweep notices. A branch that stops merging cleanly is reported here, and the ticket is not done until they all land.',
  done: 'Terminal. Nothing runs here — arriving is completing.',
};

/**
 * A span as a person reads it. Sub-minute keeps a decimal because gate times
 * live there; above a minute the decimal is noise.
 */
export function formatDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Time of day, in the reader's own locale. Empty for an unparseable stamp. */
export function formatTime(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/**
 * The strip's header line for a stage.
 *
 * `now` is injected rather than read from the clock so this stays pure and
 * testable; a running stage's elapsed time is therefore as fresh as the last
 * state push, which is every driver progress tick.
 */
export function formatClock(cell: StepperCell, now: string): string {
  const attempt = cell.attempt && cell.attempt > 0 ? ` · attempt ${cell.attempt}` : '';

  if (!cell.startedAt) {
    return cell.status === 'pending' ? 'has not run yet' : '';
  }
  if (cell.status === 'running') {
    const elapsed = formatDuration(cell.startedAt, now);
    return `started ${formatTime(cell.startedAt)}${elapsed ? ` · ${elapsed} elapsed` : ''}${attempt}`;
  }
  const took = formatDuration(cell.startedAt, cell.endedAt);
  return `${formatTime(cell.startedAt)}${took ? ` · ${took}` : ''}${attempt}`;
}

/** Map a stage's status onto the header dot. */
export function dotFor(cell: StepperCell): InsideDot {
  switch (cell.status) {
    case 'passed':
      return 'done';
    case 'running':
      return 'run';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'idle';
    default:
      return 'pend';
  }
}

/** Assemble one stage's strip, defaulting the parts every stage shares. */
export function inside(
  cell: StepperCell,
  now: string,
  ops: StageOp[],
  dot?: InsideDot,
): StageInside {
  return {
    stageKey: cell.stageKey,
    title: STAGE_TITLES[cell.stageKey],
    dot: dot ?? dotFor(cell),
    clock: formatClock(cell, now),
    ops,
    blurb: STAGE_BLURBS[cell.stageKey],
  };
}

/**
 * The six-stage inside contract (the inside redesign).
 *
 * The runtime stage machine keeps its own key vocabulary — seven keys
 * including `fix` (`StageKey`). The presentation model is a SEPARATE six-stage
 * contract: `fix` is not a stage a person visits, it is recovery attached to
 * the stage it returns to, so it is projected away here by
 * `insideStageForRuntimeStage` and surfaces only as a `recovery` process. The
 * runtime model (`StageKey`, the graph) is never modified to match.
 */

/** The six stages the inside view presents. Deliberately not `StageKey`. */
export type InsideStageKey = 'scope' | 'impl' | 'uat' | 'review' | 'ship' | 'done';

/** A process id within the inside contract — `gates`, `commit`, `delivery-receipt`. */
export type InsideProcessId = string;

/** How one process row reads to the eye. The same vocabulary as `OpStatus`. */
export type InsideStatus = 'pending' | 'run' | 'wait' | 'pass' | 'fail' | 'note' | 'skip';

/** The AI identity of one execution, as displayed. */
export interface AgentExecutionView {
  agentName?: string;
  provider: string;
  providerLabel: string;
  model: string | null;
  modelLabel: string;
}

/** What a process row's control can ask the host to do. */
export type InsideActionKind =
  | 'open-pr'
  | 'open-commit'
  | 'open-file'
  | 'open-stage-log'
  | 'resume-stage'
  | 'open-full-evidence';

/**
 * A navigation/continuation control on a process row.
 *
 * `actionId` is an opaque snapshot-scoped capability: never a path, URL, repo,
 * SHA, or PR number — the host resolves it through a ticket-scoped allowlist
 * and the webview posts only the id back. `kind` is a presentation hint only;
 * the host does not trust it on dispatch.
 */
export interface TypedInsideAction {
  actionId: string;
  kind: InsideActionKind;
}

/**
 * The ticket-less target shape a REDUCER hands to the host's attach closure.
 * The reducers are pure and ticket-agnostic; the closure (built around the
 * host's `InsideActionRegistry`, `ui/dashboard/insideActions.ts`) owns the
 * ticket id, mints the opaque action id, and returns the `{actionId, kind}`
 * the row carries.
 */
export type InsideEvidenceTarget =
  | {
      kind: 'open-file';
      evidence: { source: 'review-finding' | 'uat-finding'; id: number };
    }
  | { kind: 'open-commit'; shipCommitId: number }
  | { kind: 'open-full-evidence'; processRunId: number };

/** Preformatted token counts — a view never formats a number. */
export interface TokenUsageView {
  /** Preformatted total — `12.4k`. */
  total: string;
  /** Preformatted exact total — `12,435` — for a title attribute. */
  exact?: string;
  /** True only when the counts are an estimate, never a measurement. */
  estimated: boolean;
}

/** One line inside a process's evidence block. */
export interface EvidenceRow {
  label: string;
  detail?: string;
  status?: InsideStatus;
  duration?: string;
  action?: TypedInsideAction;
}

/**
 * What happened inside one process, keyed by how it must render. A closed
 * union: a process's evidence kind is chosen from this list at reduce time
 * (unknown process ids get the generic `rows` member), so the webview's
 * renderer switch never meets an unhandled kind.
 */
export type ProcessEvidenceView =
  | { kind: 'rows'; rows: readonly EvidenceRow[] }
  | {
      kind: 'gates';
      rows: readonly EvidenceRow[];
      passed: number;
      failed: number;
      skipped: number;
    }
  | { kind: 'findings'; rows: readonly EvidenceRow[]; blocking: number }
  | { kind: 'timeline'; rows: readonly EvidenceRow[] }
  | { kind: 'commits'; rows: readonly EvidenceRow[]; total?: number }
  | { kind: 'prs'; rows: readonly EvidenceRow[]; open: number; merged: number }
  | { kind: 'recovery'; rows: readonly EvidenceRow[] }
  | { kind: 'receipt'; rows: readonly EvidenceRow[] };

/** The closed kind vocabulary, in one place — mirrors the union above. */
export const EVIDENCE_KINDS: readonly ProcessEvidenceView['kind'][] = [
  'rows',
  'gates',
  'findings',
  'timeline',
  'commits',
  'prs',
  'recovery',
  'receipt',
] as const;

/** One process inside one inside stage. A snapshot, no functions. */
export interface InsideProcessView {
  id: string;
  kind: string;
  label: string;
  status: InsideStatus;
  detail?: string;
  count?: string;
  duration?: string;
  ai?: boolean;
  /** The execution karst actually ran, when it ran one. */
  execution?: AgentExecutionView;
  /** What the settings said WOULD run, for a process that has not run. */
  configuredExecution?: AgentExecutionView;
  tokens?: TokenUsageView;
  evidence?: ProcessEvidenceView;
  action?: TypedInsideAction;
}

/**
 * The full presentation model for ONE inside stage. The inside redesign's
 * successor to `StageInside`: the flat operation rows become ordered
 * processes, each carrying its own evidence and controls.
 */
export interface InsideStageView {
  stageKey: InsideStageKey;
  /** Display title — `Implementation`, `UAT`. */
  title: string;
  dot: InsideDot;
  /** `12:23:06 · 51.7s · attempt 1`, or `has not run yet`. */
  clock: string;
  /** Ordered processes. EMPTY means nothing ran — the view shows `blurb` instead. */
  processes: InsideProcessView[];
  /** The static "what happens here" copy. Always present. */
  blurb: string;
}

/**
 * The PR facts the ship strip reads — a structural subset of `PrView`, so the
 * strip states only what it renders and a caller with a partial row (a test, an
 * older snapshot) still type-checks. The v16 metadata is optional for exactly
 * that reason: absent is a state the strip must handle anyway.
 */
export interface ShipPrView {
  /** The repository path — identity. */
  repo: string;
  /** The repository as displayed (path-display preference). Falls back to `repo`. */
  repoDisplay?: string;
  number: number | null;
  /** `open` | `merged` | `closed` | … as `prs.status` holds it, when known. */
  status?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  mergedAt?: string | null;
}
