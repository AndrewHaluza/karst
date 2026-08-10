import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type { ProcessRun } from '../../store/processRuns.js';
import {
  parseShipPreState,
  type ShipEvidence,
  type ShipRepoStepEvidence,
} from '../../store/shipRuns.js';
import { summarizeMergeCheck } from '../mergeCheckView.js';
import type { StepperCell } from '../stepper.js';
import { boundedEvidenceRows } from './bounds.js';
import { bounded } from './bounds.js';
import { executionView, tokenView, type SessionTokensInput } from './agent.js';
import {
  formatDuration,
  formatExactDuration,
  formatTime,
  type CommitEntryView,
  type CommitRepoView,
  type EvidenceRow,
  type InsideEvidenceTarget,
  type InsideProcessView,
  type InsideStatus,
  type PrBranchView,
  type PrStepView,
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
export const REPOSITORY_EVIDENCE_LIMIT = 6;

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
  /**
   * The manifest repository NAME for a recorded repo value (the evidence
   * tables key by repo PATH). The ship rows show the name, never the path;
   * a repo the host cannot map falls back to the raw recorded value.
   */
  repoNameFor?: (repo: string) => string | undefined;
  /**
   * Every process run recorded for the ticket — the PR row's AI identity is
   * the `pr-description` run's snapshot, like every other inside AI process.
   */
  processRuns?: readonly ProcessRun[];
  /** Recorded spend of the PR-description process; omitted when unmeasured. */
  tokens?: SessionTokensInput | null;
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
function boundedRepoRows(
  input: ShipProcessesInput,
  title: string,
  rows: readonly EvidenceRow[],
): EvidenceRow[] {
  return boundedEvidenceRows(
    rows,
    REPOSITORY_EVIDENCE_LIMIT,
    input.attach
      ? (allRows) =>
          input.attach?.({
            kind: 'open-bounded-evidence',
            title,
            rows: allRows,
            // handoff §10: the continuation says exactly what it reveals.
            label: `Show ${Math.max(0, allRows.length - REPOSITORY_EVIDENCE_LIMIT)} more`,
          })
      : undefined,
  );
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

/**
 * Bound the RICH per-repository blocks the same way `boundedRepoRows` bounds
 * the flat rows, and hand back the remainder as its own `EvidenceRow` rather
 * than as a block the grid would have to render as a fake repository. The
 * continuation is minted over the FULL recorded rows, so "Show N more" opens
 * exactly what the bound withheld.
 */
function boundedBlocks<T>(
  input: ShipProcessesInput,
  title: string,
  blocks: readonly T[],
  allRows: readonly EvidenceRow[],
): { shown: readonly T[]; overflow?: EvidenceRow } {
  const result = bounded(blocks, REPOSITORY_EVIDENCE_LIMIT);
  if (result.remaining === 0) return { shown: result.shown };
  const action = input.attach?.({
    kind: 'open-bounded-evidence',
    title,
    rows: allRows,
    label: `Show ${result.remaining} more`,
  });
  return {
    shown: result.shown,
    overflow: {
      status: 'note',
      label: 'more',
      detail: `+${result.remaining} more`,
      ...(action ? { action } : {}),
    },
  };
}

/** The displayed object id: git's own abbreviation length, formatted host-side. */
const SHORT_SHA = 7;

/**
 * A repo's commit state is SETTLED when the ship either recorded a commit step
 * (`passed` — commits landed; `note` — nothing to commit) or recorded commits
 * of any origin. A settled repo is commit-ready, and a repo that is not
 * settled has no claim at all.
 */
function commitSettled(repo: ShipRepoStepEvidence | undefined, commits: readonly { origin: string }[]): boolean {
  if (!repo) return commits.length > 0;
  return repo.status === 'passed' || repo.status === 'note' || commits.length > 0;
}

/**
 * The commit process's status, over the RECORDED repos: fail beats run, and a
 * pass is claimed when EVERY repo is settled — a "nothing to commit" note or a
 * repo that only carried pre-existing commits is a completed commit phase, not
 * absence. That is the difference from `aggregateStatus`: a green checkmark on
 * Commit is what the ticket asked for, and it must not depend on every repo
 * recording a literal `passed` commit step.
 */
function commitStatus(input: ShipProcessesInput, repos: readonly string[]): InsideStatus {
  if (repos.length === 0) return ranStatus(input);
  let settled = 0;
  for (const repo of repos) {
    const evidence = input.evidence.repos[repo]!;
    const step = evidence.steps.commit;
    if (step?.status === 'failed') return 'fail';
    if (step?.status === 'running') return 'run';
    if (commitSettled(step, evidence.commits)) settled += 1;
  }
  return settled === repos.length ? 'pass' : 'note';
}

/**
 * The process-row description: how many repositories are commit-ready and how
 * many of those were created in THIS ship ("2 repositories commit-ready · 1
 * created in Ship"). A repo whose commits all predate the ship is commit-ready
 * without being created by it.
 */
function commitDetail(repos: readonly string[], evidence: ShipEvidence): string {
  const ready = repos.filter((repo) => {
    const ev = evidence.repos[repo]!;
    return commitSettled(ev.steps.commit, ev.commits);
  }).length;
  const created = repos.filter((repo) =>
    evidence.repos[repo]!.commits.some((c) => c.origin === 'created-by-ship'),
  ).length;
  const plural = ready === 1 ? 'repository' : 'repositories';
  const createdPart = created > 0 ? ` · ${created} created in Ship` : '';
  return `${ready} ${plural} commit-ready${createdPart}`;
}

/**
 * One repository's commit block. The pill and the list ALWAYS agree: a repo
 * that produced ship commits shows those, a repo that only carried
 * pre-existing ones says so and shows those, and a repo karst recorded no
 * commit for states the absence rather than showing an empty delivery.
 */
function commitRepoView(
  input: ShipProcessesInput,
  repo: string,
  commits: readonly { id: number; sha: string; message: string; origin: string }[],
): CommitRepoView {
  const created = commits.filter((c) => c.origin === 'created-by-ship');
  const before = commits.filter((c) => c.origin === 'before-ship');
  const listed = created.length > 0 ? created : before;
  const entry = (c: (typeof commits)[number]): CommitEntryView => {
    const action = input.attach?.({ kind: 'open-commit', shipCommitId: c.id });
    return { sha: c.sha.slice(0, SHORT_SHA), message: c.message, ...(action ? { action } : {}) };
  };
  const step = input.evidence.repos[repo]!.steps.commit;
  return {
    repo: input.repoNameFor?.(repo) ?? repo,
    summary: `${created.length} created · ${before.length} before`,
    origin:
      created.length > 0
        ? 'created by ship'
        : before.length > 0
          ? 'already committed'
          : 'no commits recorded',
    originKind: created.length > 0 ? 'ship' : before.length > 0 ? 'existing' : 'none',
    ...(step?.startedAt ? { time: formatTime(step.startedAt) } : {}),
    commits: listed.map(entry),
  };
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
        label: input.repoNameFor?.(repo) ?? repo,
        detail,
        ...(action ? { action } : {}),
        ...(step?.startedAt
          ? {
              duration: formatDuration(step.startedAt, step.endedAt ?? input.now),
              durationExact: formatExactDuration(step.startedAt, step.endedAt ?? input.now),
              time: formatTime(step.startedAt),
            }
          : {}),
      };
    },
  );
  const rows = boundedRepoRows(input, 'Ship · Commit', recorded);
  const blocks = boundedBlocks(
    input,
    'Ship · Commit',
    repos.map((repo) => commitRepoView(input, repo, input.evidence.repos[repo]!.commits)),
    recorded,
  );
  const total = Object.values(input.evidence.repos).reduce(
    (sum, r) => sum + r.commits.filter((c) => c.origin === 'created-by-ship').length,
    0,
  );
  return {
    id: 'commit',
    kind: 'commit',
    label: 'Commit',
    status: repos.length > 0 ? commitStatus(input, repos) : ranStatus(input),
    ...(repos.length > 0
      ? { detail: commitDetail(repos, input.evidence) }
      : { detail: noEvidenceDetail(input) }),
    // The kind-specific aggregate (B4): created-by-ship commits only — a
    // pre-existing commit is not delivery. Omitted when none were created.
    ...(total > 0 ? { aggregate: `${total} commits` } : {}),
    evidence: {
      kind: 'commits',
      rows,
      total,
      ...(blocks.shown.length > 0 ? { repos: blocks.shown } : {}),
      ...(blocks.overflow ? { overflow: blocks.overflow } : {}),
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

/**
 * A push's relation to the remote branch, from the PERSISTED pre-state: a
 * `preRemoteHead` names a branch that existed → this push updated it; null
 * means the branch did not exist → this push created it. The design's copy is
 * "1 existing → update · 1 missing → create". A run that recorded no push
 * intent (a legacy ship, an unresolved pre-state) states nothing — the step's
 * own detail stands in.
 */
function pushRelation(input: ShipProcessesInput, repo: string): string | null {
  const intent = input.evidence.repos[repo]?.intents.push;
  if (!intent) return null;
  const pre = parseShipPreState(intent.preStateJson, 'push');
  if (pre?.step !== 'push') return null;
  return pre.preRemoteHead === null ? 'missing → create' : 'existing → update';
}

/** The push process: per repo, the push step's recorded outcome. */
function pushProcess(input: ShipProcessesInput): InsideProcessView {
  const repos = Object.keys(input.evidence.repos).sort();
  const recorded = repos.map(
    (repo): EvidenceRow => {
      const step = input.evidence.repos[repo]!.steps.push;
      return {
        status: stepStatus(step),
        label: input.repoNameFor?.(repo) ?? repo,
        detail: pushRelation(input, repo) ?? (step?.detail || 'no push recorded'),
        ...(step?.startedAt
          ? {
              duration: formatDuration(step.startedAt, step.endedAt ?? input.now),
              durationExact: formatExactDuration(step.startedAt, step.endedAt ?? input.now),
              time: formatTime(step.startedAt),
            }
          : {}),
      };
    },
  );
  const rows = boundedRepoRows(input, 'Ship · Push', recorded);
  const pushed = recorded.filter((r) => r.status === 'pass').length;
  return {
    id: 'push',
    kind: 'push',
    label: 'Push',
    status: recorded.length > 0 ? aggregateStatus(recorded) : ranStatus(input),
    ...(recorded.length > 0
      ? { detail: `${pushed}/${recorded.length} pushed` }
      : { detail: noEvidenceDetail(input) }),
    evidence: { kind: 'rows', rows },
  };
}

/**
 * One repository's pull-request path, from the RECORDED steps alone.
 *
 * Every cell is absence-safe. A number karst never recorded is not invented —
 * the row shows `no PR` and its note says the number appears once Open
 * succeeds. A PR whose current status karst has not probed carries no state
 * pill; an unprobed PR is not an open one. The step sequence lists only the
 * steps that were actually recorded, so a run that never reached `describe`
 * does not show a describe step at all.
 */
function prBranchView(
  input: ShipProcessesInput,
  repo: string,
  current: ReadonlyMap<string, ShipPrView>,
): PrBranchView {
  const evidence = input.evidence.repos[repo]!;
  const describe = evidence.steps.describe;
  const step = evidence.steps.pr;
  const pr = current.get(repo);
  const recordedNumber = step?.number ?? pr?.number ?? null;
  const number = recordedNumber === null ? '' : `#${recordedNumber}`;
  const prState = number && pr?.status ? pr.status : '';

  const steps: PrStepView[] = [];
  if (describe) {
    steps.push(
      describe.status === 'failed'
        ? { label: 'description failed', state: 'fail' }
        : describe.status === 'running'
          ? { label: 'generating description', state: 'current' }
          : describe.status === 'note'
            ? { label: 'no description needed', state: 'note' }
            : { label: 'description generated', state: 'done' },
    );
  }

  let note: string;
  if (!step) {
    steps.push({ label: 'pr step not recorded', state: 'note' });
    note = 'No pull-request step was recorded for this repository.';
  } else if (step.status === 'note') {
    steps.push({ label: 'no PR needed', state: 'note' });
    note = 'No PR was created because this repository had no changes.';
  } else if (step.status === 'failed') {
    steps.push({ label: 'PR failed', state: 'fail' });
    note = step.detail
      ? `The pull-request step failed: ${step.detail}`
      : 'The pull-request step failed; no detail was recorded.';
  } else if (step.status === 'running') {
    steps.push({ label: 'opening PR', state: 'current' });
    note = 'The pull-request step is still running.';
  } else if (step.existedBeforeShip === true) {
    steps.push({ label: 'PR adopted', state: 'done' });
    note = number
      ? `No create step because ${number} already existed.`
      : 'The pull request already existed; its number was not recorded.';
  } else {
    steps.push({ label: 'PR opened', state: 'done' });
    note = number
      ? `PR ${number} was created in this ship run.`
      : 'The pull request was created; its number was not recorded yet.';
  }

  return {
    repo: input.repoNameFor?.(repo) ?? repo,
    number,
    prState,
    ...(number ? {} : { emptyLabel: 'no PR' }),
    steps,
    note,
    current: step?.status === 'running' || step?.status === 'failed',
    // The number is the open-PR control: it carries the opaque capability the
    // host resolves through the CURRENT prs row it minted it from.
    ...(number && pr?.id
      ? { action: input.attach?.({ kind: 'open-pr', prId: pr.id }) }
      : {}),
  };
}

/** The latest invocation of a process, by its explicit run id. */
function latestProcessRun(runs: readonly ProcessRun[], processId: string): ProcessRun | undefined {
  let best: ProcessRun | undefined;
  for (const run of runs) {
    if (run.processId !== processId) continue;
    if (best === undefined || run.id > best.id) best = run;
  }
  return best;
}

/**
 * The pr process: per repo, how the PR came to be — adopted (it already
 * existed when ship ran) or created — with its number when recorded. The row
 * carries the PR-description execution like every other AI process: the
 * `pr-description` process run snapshots the identity that actually wrote the
 * bodies, and the recorded spend rides the Σ pill.
 */
function prProcess(input: ShipProcessesInput): InsideProcessView {
  const repos = Object.keys(input.evidence.repos).sort();
  const recorded = repos.map(
    (repo): EvidenceRow => {
      const step = input.evidence.repos[repo]!.steps.pr;
      if (!step) {
        return {
          status: 'note',
          label: input.repoNameFor?.(repo) ?? repo,
          detail: 'pr step not recorded',
        };
      }
      // A note step is ship's own "no PR needed" record (a repo with no
      // changes from base). handoff §11 copy states it; it is NOT a failure
      // and NOT "created — number pending".
      if (step.status === 'note') {
        return {
          status: 'note',
          label: input.repoNameFor?.(repo) ?? repo,
          detail: 'No PR was created because this repository had no changes',
        };
      }
      const kind = step.existedBeforeShip === true ? 'adopted' : 'created';
      const number = step.number ? ` #${step.number}` : kind === 'created' ? ' — number pending' : '';
      return {
        status: stepStatus(step),
        label: input.repoNameFor?.(repo) ?? repo,
        detail: `${kind}${number}`,
        ...(step.startedAt
          ? {
              duration: formatDuration(step.startedAt, step.endedAt ?? input.now),
              durationExact: formatExactDuration(step.startedAt, step.endedAt ?? input.now),
              time: formatTime(step.startedAt),
            }
          : {}),
      };
    },
  );
  const rows = boundedRepoRows(input, 'Ship · Pull request', recorded);
  const current = currentPerRepo(input.prs);
  const currentByRepo = new Map(current.map((p) => [p.repo, p]));
  const branches = boundedBlocks(
    input,
    'Ship · Pull request',
    repos.map((repo) => prBranchView(input, repo, currentByRepo)),
    recorded,
  );
  const merged = current.filter(isMerged).length;
  const open = current.length - merged;
  // The kind-specific aggregate (B4): the CURRENT PRs, counted — "1 merged ·
  // 2 open". An unknown PR state is UNMERGED, so it lands in `open`, the same
  // reading the merge process gives it. Omitted when no current PR exists.
  const aggregate =
    current.length === 0
      ? undefined
      : [merged > 0 ? `${merged} merged` : '', open > 0 ? `${open} open` : '']
          .filter(Boolean)
          .join(' · ');
  // The recorded path, counted from the STEPS (never from detail prose): how
  // many PRs this ship CREATED vs ADOPTED ("1 created · 1 adopted") — the
  // row's description, like Commit's and Push's. Absent while nothing recorded.
  const created = repos.filter((repo) => {
    const step = input.evidence.repos[repo]!.steps.pr;
    return step?.status !== 'note' && step?.existedBeforeShip === false;
  }).length;
  const adopted = repos.filter(
    (repo) => input.evidence.repos[repo]!.steps.pr?.existedBeforeShip === true,
  ).length;
  const detail =
    created + adopted > 0
      ? [`${created} created`, adopted > 0 ? `${adopted} adopted` : '']
          .filter(Boolean)
          .join(' · ')
      : undefined;
  const describeRun = latestProcessRun(input.processRuns ?? [], 'pr-description');
  return {
    id: 'pr',
    kind: 'pr',
    label: 'Pull request',
    status: recorded.length > 0 ? aggregateStatus(recorded) : ranStatus(input),
    ...(recorded.length === 0 ? { detail: noEvidenceDetail(input) } : {}),
    ...(detail ? { detail } : {}),
    ...(aggregate ? { aggregate } : {}),
    // The AI identity that wrote the descriptions — recorded at ship time,
    // never the current settings.
    ...(describeRun?.provider ? { execution: executionView(describeRun.provider, describeRun.model) } : {}),
    ...(input.tokens ? { tokens: tokenView(input.tokens) } : {}),
    evidence: {
      kind: 'prs',
      rows,
      open,
      merged,
      ...(branches.shown.length > 0 ? { branches: branches.shown } : {}),
      ...(branches.overflow ? { overflow: branches.overflow } : {}),
    },
  };
}

/**
 * The merge process: has each CURRENT PR landed. Answered from current state,
 * never from the saga evidence — a merged PR stops being a question the
 * moment it is merged, and the last pre-merge verdict must not freeze beside
 * it. An open, draft or conflicted PR is a `wait`: only a literal `merged`
 * reads as a pass.
 *
 * Each expanded row names the repo (the manifest name, never the path), the
 * PR number with its state chip, and the timestamp of the fact the row reads:
 * the merge stamp for a merged PR, the last merge check for one still open.
 */
function mergeProcess(input: ShipProcessesInput): InsideProcessView {
  const current = currentPerRepo(input.prs);
  const checksByRepo = new Map(input.mergeChecks.map((c) => [c.repo, c]));
  const recorded = current.map((pr): EvidenceRow => {
    const name = input.repoNameFor?.(pr.repo) ?? (pr.repoDisplay || pr.repo);
    const number = pr.number ? `#${pr.number}` : '';
    const row: EvidenceRow = {
      status: isMerged(pr) ? 'pass' : 'wait',
      label: name,
      ...(number ? { detail: number } : {}),
      ...(pr.status ? { prState: pr.status } : {}),
    };
    if (isMerged(pr)) {
      return {
        ...row,
        label: `${name} · merged`,
        ...(pr.mergedAt ? { time: formatTime(pr.mergedAt) } : {}),
      };
    }
    const check = checksByRepo.get(pr.repo);
    if (check && check.state === 'conflicted') {
      return {
        ...row,
        label: `${name} · conflict`,
        detail: number ? `${number} · ${summarizeMergeCheck(check)}` : summarizeMergeCheck(check),
        ...(check.checkedAt ? { time: formatTime(check.checkedAt) } : {}),
      };
    }
    if (pr.status === 'draft') {
      return {
        ...row,
        label: `${name} · draft`,
        detail: number ? `${number} · draft — not merged yet` : 'draft — not merged yet',
        ...(check?.checkedAt ? { time: formatTime(check.checkedAt) } : {}),
      };
    }
    return {
      ...row,
      label: `${name} · open`,
      detail: number ? `${number} · not merged yet` : 'not merged yet',
      ...(check?.checkedAt ? { time: formatTime(check.checkedAt) } : {}),
    };
  });
  const allMerged = recorded.length > 0 && recorded.every((r) => r.status === 'pass');
  const conflicted = recorded.filter((r) => r.label.endsWith(' · conflict')).length;
  const merged = recorded.filter((r) => r.status === 'pass').length;
  const rows = boundedRepoRows(input, 'Ship · Merge', recorded);
  return {
    id: 'merge',
    kind: 'merge',
    label: 'Merge',
    status: recorded.length > 0 ? (allMerged ? 'pass' : 'wait') : ranStatus(input),
    // handoff §11: a conflict is a WAIT that names what the user must do —
    // the per-repo rows keep their factual readings; the sentence is the
    // collapsed summary.
    ...(conflicted > 0
      ? { detail: 'Ship is waiting: resolve the merge conflict before the ticket can be done.' }
      : recorded.length === 0 && input.cell.startedAt
        ? { detail: 'nothing to merge — no pull request opened' }
        : rows.length === 0
          ? { detail: noEvidenceDetail(input) }
          // The row describes EVERY state: the merged count over the CURRENT
          // PRs, the same count shape Push's description uses — "1/2 merged",
          // "2/2 merged" (869egdr2u-fu1: the row had no description at all).
          // An unknown PR status is UNMERGED, so it reads in the open half.
          : { detail: `${merged}/${recorded.length} merged` }),
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
