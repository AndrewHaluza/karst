import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type {
  ShipEvidence,
  ShipRepoStepEvidence,
} from '../../store/shipRuns.js';
import { summarizeMergeCheck } from '../mergeCheckView.js';
import type { StepperCell } from '../stepper.js';
import { bounded } from './bounds.js';
import {
  formatDuration,
  type EvidenceRow,
  type InsideEvidenceTarget,
  type InsideProcessView,
  type InsideStatus,
  type ShipPrView,
  type TypedInsideAction,
} from './types.js';

/**
 * The ship stage's PROCESS reducer (Task 12): commit, push, pr, merge, in
 * `INSIDE_PROCESSES.ship` order.
 *
 * The first three read the DURABLE saga evidence (`ship_commits`,
 * `ship_repo_steps`): provenance and per-step outcomes that only persisted
 * rows can claim. The merge process is a different question — "has this repo
 * landed NOW" — and is answered from CURRENT `prs`/`merge_checks`, current-PR
 * scoped, exactly like the legacy strip's landing rows. A landing is never a
 * failed verdict: an open or conflicted PR is a `wait`, because nothing is
 * wrong with the work — the ticket is simply held until the PR lands.
 *
 * Missing historical facts render as absence: a ticket that shipped before
 * the evidence tables existed shows `note` rows stating there is no recorded
 * evidence, never fabricated steps.
 */

/** Cap on per-repo rows before the remainder row takes over. */
const REPO_ROWS_LIMIT = 6;

export interface ShipProcessesInput {
  cell: StepperCell;
  /** The ticket's durable saga evidence (latest run), or an empty shell. */
  evidence: ShipEvidence;
  /** Current PR rows, ticket-wide — the merge process's source of truth. */
  prs: readonly ShipPrView[];
  mergeChecks: readonly MergeCheckRow[];
  now: string;
  /**
   * Mint an opaque action for an evidence row, or return undefined when the
   * caller attaches none. Absent → rows carry no actions.
   */
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
}

/**
 * One PR per repo — the CURRENT one — mirroring `store/prs.ts`'s
 * `CURRENT_PR_ORDER`: an open PR wins, otherwise the highest number.
 *
 * A repo re-shipped after a merge carries both rows in `prs` (`ship` inserts a
 * fresh row rather than reusing a terminal one). The stale `merged` beside a
 * live `open` would answer "has this repo landed" twice.
 */
export function currentPerRepo(prs: readonly ShipPrView[]): ShipPrView[] {
  const byRepo = new Map<string, ShipPrView>();
  for (const pr of prs) {
    const held = byRepo.get(pr.repo);
    if (!held) {
      byRepo.set(pr.repo, pr);
      continue;
    }
    if (held.status === 'open') continue;
    if (pr.status === 'open' || (pr.number ?? -1) > (held.number ?? -1)) byRepo.set(pr.repo, pr);
  }
  return [...byRepo.values()];
}

/** A step's state as its process row reads. */
function stepStatus(step: ShipRepoStepEvidence | undefined): InsideStatus {
  if (!step) return 'note';
  switch (step.status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'running':
      return 'run';
    case 'note':
      return 'note';
  }
}

/**
 * A repo's delivery is landed only when its CURRENT PR's status literally
 * reads `merged`. Any other reading — `open`, `unknown` (a degraded probe),
 * `closed`, a null status — is not landed, however well-stamped `mergedAt`
 * is. `mergedAt` is display metadata, never landing authority. The one
 * predicate both Ship and Done consume, so a landing has exactly one answer.
 */
export const isMerged = (pr: ShipPrView): boolean => pr.status === 'merged';

/** Bound per-repo rows and name the remainder. */
function boundedRepoRows(rows: readonly EvidenceRow[]): EvidenceRow[] {
  const boundedRows = bounded(rows, REPO_ROWS_LIMIT);
  const out = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    out.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }
  return out;
}

/**
 * One process's status from its recorded rows: fail beats run, and a pass is
 * claimed only when EVERY required recorded row is green — a single `note` (or
 * a missing record) is absence and keeps the process from reading as done.
 * Aggregated over the recorded rows BEFORE the display bound truncates them:
 * the "+N more" remainder marker is presentation, not a recorded row.
 */
function aggregateStatus(rows: readonly EvidenceRow[]): InsideStatus {
  if (rows.some((r) => r.status === 'fail')) return 'fail';
  if (rows.some((r) => r.status === 'run')) return 'run';
  if (rows.length > 0 && rows.every((r) => r.status === 'pass' || r.status === 'skip')) return 'pass';
  return 'note';
}

/** The commit process: per repo, what the ship created vs what was already there. */
function commitProcess(input: ShipProcessesInput): InsideProcessView {
  const repos = Object.keys(input.evidence.repos).sort();
  const recorded = repos.map(
    (repo): EvidenceRow => {
      const evidence = input.evidence.repos[repo]!;
      const created = evidence.commits.filter((c) => c.origin === 'created-by-ship');
      const before = evidence.commits.filter((c) => c.origin === 'before-ship').length;
      const step = evidence.steps.commit;
      const detail =
        created.length + before > 0
          ? `${created.length} created${before > 0 ? ` · ${before} before` : ''}`
          : step?.detail || 'no commits recorded';
      const action = input.attach && created.length === 1
        ? input.attach({ kind: 'open-commit', shipCommitId: created[0]!.id })
        : undefined;
      return {
        status: stepStatus(step),
        label: repo,
        detail,
        ...(action ? { action } : {}),
        ...(step?.startedAt ? { duration: formatDuration(step.startedAt, step.endedAt ?? input.now) } : {}),
      };
    },
  );
  const rows = boundedRepoRows(recorded);
  return {
    id: 'commit',
    kind: 'commit',
    label: 'Commit',
    status: recorded.length > 0 ? aggregateStatus(recorded) : ranStatus(input),
    ...(recorded.length === 0 ? { detail: noEvidenceDetail(input) } : {}),
    evidence: {
      kind: 'commits',
      rows,
      total: Object.values(input.evidence.repos).reduce(
        (sum, r) => sum + r.commits.filter((c) => c.origin === 'created-by-ship').length,
        0,
      ),
    },
  };
}

/** What a process with no recorded rows states, honestly. */
function ranStatus(input: ShipProcessesInput): InsideStatus {
  return input.cell.status === 'pending' ? 'pending' : 'note';
}

function noEvidenceDetail(input: ShipProcessesInput): string {
  return input.cell.status === 'pending'
    ? 'resolved when ship runs'
    : 'no recorded evidence for this ship';
}

/** The push process: per repo, the push step's recorded outcome. */
function pushProcess(input: ShipProcessesInput): InsideProcessView {
  const repos = Object.keys(input.evidence.repos).sort();
  const recorded = repos.map(
    (repo): EvidenceRow => {
      const step = input.evidence.repos[repo]!.steps.push;
      return {
        status: stepStatus(step),
        label: repo,
        detail: step?.detail || 'no push recorded',
        ...(step?.startedAt ? { duration: formatDuration(step.startedAt, step.endedAt ?? input.now) } : {}),
      };
    },
  );
  const rows = boundedRepoRows(recorded);
  return {
    id: 'push',
    kind: 'push',
    label: 'Push',
    status: recorded.length > 0 ? aggregateStatus(recorded) : ranStatus(input),
    ...(recorded.length === 0 ? { detail: noEvidenceDetail(input) } : {}),
    evidence: { kind: 'rows', rows },
  };
}

/**
 * The pr process: per repo, how the PR came to be — adopted (it already
 * existed when ship ran) or created — with its number when recorded.
 */
function prProcess(input: ShipProcessesInput): InsideProcessView {
  const repos = Object.keys(input.evidence.repos).sort();
  const recorded = repos.map(
    (repo): EvidenceRow => {
      const step = input.evidence.repos[repo]!.steps.pr;
      if (!step) {
        return { status: 'note', label: repo, detail: 'pr step not recorded' };
      }
      const kind = step.existedBeforeShip === true ? 'adopted' : 'created';
      const number = step.number ? ` #${step.number}` : kind === 'created' ? ' — number pending' : '';
      return {
        status: stepStatus(step),
        label: repo,
        detail: `${kind}${number}`,
        ...(step.startedAt ? { duration: formatDuration(step.startedAt, step.endedAt ?? input.now) } : {}),
      };
    },
  );
  const rows = boundedRepoRows(recorded);
  const current = currentPerRepo(input.prs);
  const merged = current.filter(isMerged).length;
  const open = current.length - merged;
  return {
    id: 'pr',
    kind: 'pr',
    label: 'Pull request',
    status: recorded.length > 0 ? aggregateStatus(recorded) : ranStatus(input),
    ...(recorded.length === 0 ? { detail: noEvidenceDetail(input) } : {}),
    evidence: { kind: 'prs', rows, open, merged },
  };
}

/**
 * The merge process: has each CURRENT PR landed. Answered from current state,
 * never from the saga evidence — a merged PR stops being a question the
 * moment it is merged, and the last pre-merge verdict must not freeze beside
 * it. An open, draft or conflicted PR is a `wait`: only a literal `merged`
 * reads as a pass.
 */
function mergeProcess(input: ShipProcessesInput): InsideProcessView {
  const current = currentPerRepo(input.prs);
  const checksByRepo = new Map(input.mergeChecks.map((c) => [c.repo, c]));
  const rows = current.map((pr): EvidenceRow => {
    const label = pr.repoDisplay || pr.repo;
    const name = pr.number ? `${label} #${pr.number}` : label;
    if (isMerged(pr)) {
      return { status: 'pass', label: 'merged', detail: name };
    }
    const check = checksByRepo.get(pr.repo);
    if (check && check.state === 'conflicted') {
      return { status: 'wait', label: 'conflict', detail: `${name} · ${summarizeMergeCheck(check)}` };
    }
    if (pr.status === 'draft') {
      return { status: 'wait', label: 'draft', detail: `${name} · draft — not merged yet` };
    }
    return { status: 'wait', label: 'open', detail: `${name} · not merged yet` };
  });
  const allMerged = rows.length > 0 && rows.every((r) => r.status === 'pass');
  return {
    id: 'merge',
    kind: 'merge',
    label: 'Merge',
    status: rows.length > 0 ? (allMerged ? 'pass' : 'wait') : ranStatus(input),
    ...(rows.length === 0 && input.cell.startedAt
      ? { detail: 'nothing to merge — no pull request opened' }
      : rows.length === 0
        ? { detail: noEvidenceDetail(input) }
        : {}),
    evidence: { kind: 'rows', rows },
  };
}

/** The ship stage's processes: commit, push, pr, merge, in registry order. */
export function shipProcesses(input: ShipProcessesInput): InsideProcessView[] {
  return [
    commitProcess(input),
    pushProcess(input),
    prProcess(input),
    mergeProcess(input),
  ];
}
