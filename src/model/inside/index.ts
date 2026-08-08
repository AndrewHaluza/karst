import type { GateRun } from '../../store/gateRuns.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { MergeCheckRow } from '../../store/mergeChecks.js';
import { summarizeMergeCheck } from '../mergeCheckView.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { STAGE_KEYS } from '../types.js';
import {
  formatDuration,
  inside,
  type EvidenceRow,
  type InsideProcessView,
  type InsideStatus,
  type ShipPrView,
  type StageInside,
  type StageOp,
} from './types.js';
import { bounded } from './bounds.js';
import { reviewInside, uatInside, reviewProcesses, uatProcesses } from './gates.js';
import { insertCausalFix, recoveryProcess } from './recovery.js';
import { shipProcesses, currentPerRepo } from './ship.js';
import { doneReceipt } from './done.js';
import {
  implInside,
  fixInside,
  implementationSessionProcess,
  type SessionConfiguredInput,
  type SessionTokensInput,
  type SessionView,
} from './agent.js';

export type { StageInside, StageOp, OpStatus, InsideDot, ShipPrView } from './types.js';
export { bounded } from './bounds.js';
export type { SessionConfiguredInput, SessionTokensInput } from './agent.js';
export { implementationSessionProcess } from './agent.js';
export { uatProcesses, reviewProcesses } from './gates.js';
export type { QualityProcessesInput } from './gates.js';
export { insertCausalFix, recoveryProcess } from './recovery.js';
export type { RecoveryProcessView } from './recovery.js';
export { shipProcesses } from './ship.js';
export type { ShipProcessesInput } from './ship.js';
export { doneReceipt } from './done.js';
export type { DoneReceiptInput, DoneReceiptView } from './done.js';

/**
 * Everything needed to say what happened inside each stage — all of it already
 * loaded by the caller, so this stays pure: no store, no clock, no vscode.
 */
export interface StageInsideInput {
  stepper: readonly StepperCell[];
  gateRuns: readonly GateRun[];
  /**
   * Every review finding recorded for this ticket, ticket-wide and
   * unfiltered — `reviewInside` reduces to the latest batch itself (same
   * convention as `gateRuns`/`marks`: selection is a pure decision made in
   * this model layer, where it is testable without a DB).
   */
  findings: readonly Finding[];
  worktrees: readonly WorktreeView[];
  prs: readonly ShipPrView[];
  /**
   * Current mergeability per repo, as of the last ship. Optional: a caller that
   * predates the merge check simply renders no merge rows, which is the correct
   * reading of "we have not checked" — never "clean".
   */
  mergeChecks?: readonly MergeCheckRow[];
  session: SessionView;
  /** The hot repo set the ticket was scoped to. */
  selectedRepos: readonly string[];
  /** The approach's DECLARED workflow phase names. Never per-phase state. */
  phases: readonly string[];
  /**
   * Every phase the agent REPORTED entering, for the whole ticket, oldest first.
   * Ungrouped by contract (`listPhaseMarks`): selecting the stage and attempt is
   * a pure decision, made in the model layer where it is testable without a DB.
   */
  marks: readonly PhaseMark[];
  fixAttempts: number;
  /** Injected so a running stage's elapsed time is testable. */
  now: string;
}

/**
 * Scope's evidence is the worktrees it created — the one thing it persists.
 * `scopeTicket`'s migration warnings are computed and discarded, so there is no
 * warning row to show and inventing one would be a guess.
 */
function scopeInside(
  cell: StepperCell,
  worktrees: readonly WorktreeView[],
  selectedRepos: readonly string[],
  now: string,
): StageInside {
  if (worktrees.length === 0) {
    // The hot repo set is chosen at ticket creation, before scope ever runs —
    // static config, the same class of fact as a gate's spec list — so a
    // not-yet-started scope shows the worktree it WILL create per repo,
    // pending, instead of blurb. No repo selected yet: nothing to preview.
    if (cell.status !== 'pending' || selectedRepos.length === 0) return inside(cell, now, []);
    const count = selectedRepos.length;
    return inside(cell, now, [
      {
        status: 'pending',
        name: 'hot set',
        detail: `${count} ${count === 1 ? 'service' : 'services'} to validate against the manifest`,
        duration: '',
      },
      ...selectedRepos.map((repo): StageOp => ({
        status: 'pending',
        name: 'worktree',
        detail: repo,
        duration: '',
      })),
    ]);
  }

  const count = selectedRepos.length || worktrees.length;
  const ops: StageOp[] = [
    {
      status: 'pass',
      name: 'hot set',
      detail: `${count} ${count === 1 ? 'service' : 'services'} validated against the manifest`,
      duration: '',
    },
    ...worktrees.map((w): StageOp => ({
      status: 'pass',
      name: 'worktree',
      detail: w.branch ? `${w.repoDisplay} · ${w.branch}` : w.repoDisplay,
      duration: '',
    })),
  ];
  return inside(cell, now, ops);
}

/** The number of per-worktree detail rows one scope process row shows. */
const WORKTREE_DETAIL_LIMIT = 8;

/** Map a stage's status onto the process vocabulary. */
function stageProcessStatus(cell: StepperCell): InsideStatus {
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
 * Scope's two process rows (Task 10), in `INSIDE_PROCESSES.scope` order:
 * `hot-set` first, then `worktrees`. The hot set is ONE row whatever the repo
 * count — the count rides on it, never as a row per repo — and the worktrees
 * are one row whose evidence lists each created worktree, bounded.
 */
export function scopeProcesses(
  cell: StepperCell,
  selectedRepos: readonly string[],
  worktrees: readonly WorktreeView[],
  now: string,
): InsideProcessView[] {
  const count = selectedRepos.length;
  const ran = cell.status !== 'pending';

  const hotSet: InsideProcessView = {
    id: 'hot-set',
    kind: 'hot-set',
    label: 'Hot set',
    status: stageProcessStatus(cell),
    count: String(count),
    detail:
      count === 1
        ? `1 service ${ran ? 'validated' : 'to validate'} against the manifest`
        : `${count} services ${ran ? 'validated' : 'to validate'} against the manifest`,
    ...(cell.startedAt ? { duration: formatDuration(cell.startedAt, cell.endedAt ?? now) } : {}),
  };

  const boundedRows = bounded(
    worktrees.map(
      (w): EvidenceRow => ({
        status: 'pass',
        label: 'worktree',
        detail: w.branch ? `${w.repoDisplay} · ${w.branch}` : w.repoDisplay,
      }),
    ),
    WORKTREE_DETAIL_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  return [
    hotSet,
    {
      id: 'worktrees',
      kind: 'worktrees',
      label: 'Worktrees',
      status:
        worktrees.length > 0
          ? stageProcessStatus(cell)
          : ran
            ? 'note'
            : 'pending',
      ...(worktrees.length === 0 && ran ? { detail: 'no worktrees created' } : {}),
      evidence: { kind: 'rows', rows },
    },
  ];
}

/** `head → base` for a strip row, degrading to whichever side is known. */
function branchPair(headRef?: string | null, baseRef?: string | null): string {
  if (headRef && baseRef) return `${headRef} → ${baseRef}`;
  return headRef || (baseRef ? `→ ${baseRef}` : '');
}

/**
 * Ship's evidence is the PR rows it wrote and the merge check it recorded per
 * repo, plus — on a failure — the real error its catch stored on the stage. The
 * individual commit/push/describe steps are not recorded, so they are not
 * claimed.
 *
 * A repo with no merge check emits no merge row. Absence is evidence of nothing:
 * a ticket shipped before this existed, or a check that never got written, must
 * not be rendered as "clean".
 */
function shipInside(
  cell: StepperCell,
  prs: readonly ShipPrView[],
  mergeChecks: readonly MergeCheckRow[],
  selectedRepos: readonly string[],
  now: string,
): StageInside {
  if (cell.status === 'failed') {
    return inside(cell, now, [
      {
        status: 'fail',
        name: 'ship',
        detail: cell.reason ?? 'failed with no reason recorded',
        duration: '',
      },
    ]);
  }
  // Before ship has opened anything, `prs` is empty — but the hot repo set is
  // already known, so the pr/merge rows it WILL produce are a static fact, not
  // a guess. Shown only pre-run: once a PR exists for a repo, its real row
  // (below) replaces this one, so there is never a pending row beside a real one.
  if (prs.length === 0 && cell.status === 'pending' && selectedRepos.length > 0) {
    return inside(
      cell,
      now,
      selectedRepos.flatMap((repo): StageOp[] => [
        { status: 'pending', name: 'pr', detail: repo, duration: '' },
        { status: 'pending', name: 'merge', detail: repo, duration: '' },
      ]),
    );
  }
  // `pr` rows: ALL prs ship ever opened for this ticket, one row each — a log
  // of what happened, so a repo re-shipped after a merge shows both the old
  // row and the new one. The LANDING row below is a different question ("has
  // this repo landed NOW") and is answered separately, current-PR scoped, so
  // the two never disagree about the same repo in the same strip.
  const prOps = prs.map((pr): StageOp => {
    // The DISPLAY path, never the raw one: this row names the same directory the
    // worktree rows do, so it must obey the one path-display preference (falling
    // back to the path when a caller supplied no display form).
    const label = pr.repoDisplay || pr.repo;
    // From-to is the identity of a PR, so it belongs on the row that claims one
    // was opened. Each part is appended only when known — an unprobed PR renders
    // exactly as it did before the metadata existed, not with an empty arrow.
    const parts = [
      pr.number ? `${label} #${pr.number}` : label,
      branchPair(pr.headRef, pr.baseRef),
      pr.mergedAt ? 'merged' : '',
    ].filter((p) => p !== '');
    return { status: 'pass', name: 'pr', detail: parts.join(' · '), duration: '' };
  });
  return inside(cell, now, [...prOps, ...landingOps(cell, prs, mergeChecks)]);
}

/**
 * Per-repo landing evidence: has this repo's CURRENT pull request made it into
 * the base branch, and if not, why the ticket is still waiting on it.
 *
 * Deliberately per-REPO and not a single summary line: the ticket is held by
 * whichever repo has not landed, and naming it is the difference between "go
 * merge something" and "go merge this". A repo whose PR is merged is `pass` and
 * says so; an open one is `wait`, which is the honest reading of a step that is
 * neither working nor finished. A conflict downgrades the row to `fail` —
 * nothing is wrong with the code, but the branch cannot land as it stands, and
 * that is the one thing on this strip a person has to act on. The merge check
 * is consulted ONLY for a conflict's detail — landing itself is read off
 * `pr.status`/`pr.mergedAt`, never off the check, so a repo with no check on
 * file (a ticket shipped before merge checks existed, or one that never wrote
 * one) still gets an honest "open, not merged yet" instead of silence.
 */
function landingOps(
  cell: StepperCell,
  prs: readonly ShipPrView[],
  mergeChecks: readonly MergeCheckRow[],
): StageOp[] {
  // No PR at all. Which of two things that means depends entirely on whether the
  // stage has been ENTERED: before ship runs there is simply nothing to say yet
  // (the pre-run placeholder above covers that case and returns before this is
  // ever called), while after it there really is nothing to land — and saying
  // so is the difference between a finished ticket and a strip that looks like
  // karst forgot to check. `startedAt` is what separates the two; a confirm
  // stage parks as pending the moment it is entered, so status alone cannot.
  if (prs.length === 0) {
    if (!cell.startedAt) return [];
    return [
      {
        status: 'note',
        name: 'merge',
        detail: 'nothing was delivered — no pull request to merge',
        duration: '',
      },
    ];
  }
  const checksByRepo = new Map(mergeChecks.map((c) => [c.repo, c]));
  return currentPerRepo(prs).map((pr): StageOp => {
    const label = pr.repoDisplay || pr.repo;
    const name = pr.number ? `${label} #${pr.number}` : label;
    // Landing is read off the PR's CURRENT status, literally `merged` — a
    // `mergedAt` stamp on an `open`/`unknown` probe is display metadata, never
    // proof of a landing (Finding 11; see the note on `isMerged` in ship.ts).
    if (pr.status === 'merged') {
      return { status: 'pass', name: 'merged', detail: name, duration: '' };
    }
    const check = checksByRepo.get(pr.repo);
    if (check && check.state === 'conflicted') {
      return {
        status: 'fail',
        name: 'conflict',
        detail: `${name} · ${summarizeMergeCheck(check)}`,
        duration: '',
      };
    }
    return { status: 'wait', name: 'open', detail: `${name} · not merged yet`, duration: '' };
  });
}

function stripFor(key: StageKey, cell: StepperCell, input: StageInsideInput): StageInside {
  switch (key) {
    case 'scope':
      return scopeInside(cell, input.worktrees, input.selectedRepos, input.now);
    case 'impl':
      return implInside(cell, input.session, input.phases, input.marks, input.now);
    case 'uat':
      return uatInside(cell, input.gateRuns, input.now);
    case 'review':
      return reviewInside(cell, input.gateRuns, input.findings, input.now);
    case 'fix':
      return fixInside(cell, input.session.sessionId, input.fixAttempts, input.now);
    case 'ship':
      return shipInside(cell, input.prs, input.mergeChecks ?? [], input.selectedRepos, input.now);
    case 'done':
      // Terminal: the machine stamps started_at === ended_at, so the duration is
      // structurally zero and there is no step to report. Arriving IS the event.
      return inside(cell, input.now, []);
  }
}

/**
 * Precompute what happened inside every stage, so the panel can re-point at any
 * stage on click without a round trip to the host.
 */
export function buildStageInside(input: StageInsideInput): Record<StageKey, StageInside> {
  const byKey = new Map(input.stepper.map((c) => [c.stageKey, c]));
  const out = {} as Record<StageKey, StageInside>;
  for (const key of STAGE_KEYS) {
    out[key] = stripFor(key, byKey.get(key) ?? { stageKey: key, status: 'pending' }, input);
  }
  return out;
}
