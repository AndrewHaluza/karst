import type { GateRun } from '../../store/gateRuns.js';
import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { ShipEvidence } from '../../store/shipRuns.js';
import type { RecordedRoleUsage, RecordedUsageSummary } from '../../store/tokenUsage.js';
import { formatTokens } from '../tokenFormat.js';
import { boundedEvidenceRows } from './bounds.js';
import { latestBatch } from './gates.js';
import { currentPerRepo, isMerged, REPOSITORY_EVIDENCE_LIMIT } from './ship.js';
import type { EvidenceRow, InsideEvidenceTarget, ShipPrView, TypedInsideAction } from './types.js';

/**
 * The done stage's delivery receipt (Task 12): a DISCRIMINATED UNION — before
 * `done` there is no delivery evidence and the receipt says exactly that;
 * after `done` it names what was delivered, how it was validated, and what it
 * cost in RECORDED tokens.
 *
 * Everything reads current or durable recorded state: merged CURRENT PRs
 * (a stale merged row beside a live open one is not a delivery), ship-created
 * commits (pre-existing commits are legacy facts, omitted), the final gate
 * batches, the recovery history, and recorded-only token summaries — an
 * estimated row is never treated as spend.
 */

/** The changes-surface row is evidence, not a gate — never counted. */
const CHANGES_GATE = 'changes';

/** How the final gate batches read: counts over the LATEST runs of both stages. */
function finalGateWording(gateRuns: readonly GateRun[]): string {
  const uat = latestBatch(gateRuns, 'uat').filter((r) => r.gateName !== CHANGES_GATE);
  const review = latestBatch(gateRuns, 'review').filter((r) => r.gateName !== CHANGES_GATE);
  const batch = [...uat, ...review];
  const passed = batch.filter((r) => r.exitCode === 0).length;
  const failed = batch.filter((r) => r.exitCode !== null && r.exitCode !== 0).length;
  if (failed > 0) {
    return `${failed} gate${failed === 1 ? '' : 's'} failed on the final run`;
  }
  return `${passed} gate${passed === 1 ? '' : 's'} passed on the final run`;
}

/**
 * The delivery receipt. `pending` is the ONLY shape before `done` — no future
 * delivery evidence, no reconstructed summary. `complete` is the only shape
 * after: a merged-PR-only delivery count, the final gate wording, and the
 * recorded token total (null when nothing was recorded — a zero would read as
 * a measured free ticket).
 */
export type DoneReceiptView =
  | { status: 'pending'; title: string; detail: string }
  | {
      status: 'complete';
      delivered: { repos: number; prs: number; commits: number };
      validated: string;
      tokens: { label: string } | null;
      evidence: { kind: 'receipt'; rows: readonly EvidenceRow[] };
    };

export interface DoneReceiptInput {
  /** The runtime stage the ticket is AT — `ship` keeps the receipt pending. */
  stageCurrent: 'ship' | 'done';
  /** The durable saga evidence (latest run), or an empty shell. */
  ship: ShipEvidence;
  /** Current PR rows — merged CURRENT PRs are the delivery. */
  prs: readonly ShipPrView[];
  mergeChecks: readonly MergeCheckRow[];
  /** Ticket-wide gate runs; the FINAL batches of both gate stages are read. */
  gateRuns: readonly GateRun[];
  /** The ticket's recovery history, if any. */
  rounds: readonly RecoveryRound[];
  /** The RECORDED ticket total — estimated rows never reach this. */
  tokens: RecordedUsageSummary | null;
  /** The recorded spend per role, for the breakdown rows. */
  roles: readonly RecordedRoleUsage[];
  now: string;
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
}

export function doneReceipt(input: DoneReceiptInput): DoneReceiptView {
  if (input.stageCurrent !== 'done') {
    return {
      status: 'pending',
      title: 'Delivery receipt pending',
      detail: 'Available after every current pull request is merged',
    };
  }

  const merged = currentPerRepo(input.prs).filter(isMerged);
  const commits = Object.values(input.ship.repos).reduce(
    (sum, r) => sum + r.commits.filter((c) => c.origin === 'created-by-ship').length,
    0,
  );
  const validated = finalGateWording(input.gateRuns);

  const mergedRows = merged.map((pr): EvidenceRow => ({
      status: 'pass',
      label: 'merged',
      detail: pr.number ? `${pr.repoDisplay || pr.repo} #${pr.number}` : pr.repoDisplay || pr.repo,
  }));
  const repositoryRows = boundedEvidenceRows(
    mergedRows,
    REPOSITORY_EVIDENCE_LIMIT,
    input.attach
      ? (allRows) => input.attach?.({
          kind: 'open-bounded-evidence',
          title: 'Done · Delivery receipt',
          rows: allRows,
        })
      : undefined,
  );

  const rows: EvidenceRow[] = [
    ...repositoryRows,
    { status: 'note', label: 'commits', detail: `${commits} created by ship` },
    { status: 'note', label: 'validated', detail: validated },
    ...(input.rounds.length > 0
      ? [
          {
            status: 'note',
            label: 'recovery',
            detail: `${input.rounds.length} round${input.rounds.length === 1 ? '' : 's'} fixed before delivery`,
          } satisfies EvidenceRow,
        ]
      : []),
    ...input.roles.map(
      (role): EvidenceRow => ({
        status: 'note',
        label: role.role,
        detail: formatTokens(role.total),
      }),
    ),
  ];

  return {
    status: 'complete',
    delivered: { repos: merged.length, prs: merged.length, commits },
    validated,
    tokens:
      input.tokens === null
        ? null
        : { label: `${formatTokens(input.tokens.total)} tokens recorded` },
    evidence: { kind: 'receipt', rows },
  };
}
