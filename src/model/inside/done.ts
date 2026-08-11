import type { GateRun } from '../../store/gateRuns.js';
import type { MergeCheckRow } from '../../store/mergeChecks.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { ShipEvidence } from '../../store/shipRuns.js';
import type { RecordedRoleUsage, RecordedUsageSummary } from '../../store/tokenUsage.js';
import type { StageKey } from '../types.js';
import type { StepperCell } from '../stepper.js';
import { formatTokens } from '../tokenFormat.js';
import { boundedEvidenceRows } from './bounds.js';
import { latestBatch } from './gates.js';
import { currentPerRepo, isMerged, REPOSITORY_EVIDENCE_LIMIT } from './ship.js';
import {
  formatSpanMs,
  formatTime,
  STAGE_TITLES,
  type DoneHeroView,
  type EvidenceRow,
  type InsideEvidenceTarget,
  type ReceiptBlockView,
  type ReceiptBreakdownItem,
  type ShipPrView,
  type TypedInsideAction,
} from './types.js';

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
      /** The process-row description — dynamic per state (Task 869egdr2u). */
      detail: string;
      delivered: { repos: number; prs: number; commits: number };
      validated: string;
      tokens: { label: string } | null;
      evidence: {
        kind: 'receipt';
        rows: readonly EvidenceRow[];
        hero: DoneHeroView;
        blocks: readonly ReceiptBlockView[];
        /** The Timing strip: stage spans and their sum as the stated total. */
        timing?: { label: string; total: string; items: string };
      };
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
  /**
   * When the done stage was stamped — the hero's completion time. NULL when
   * no stamp was recorded, which renders as an EMPTY time, never as "now".
   */
  completedAt?: string | null;
  now: string;
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
  /**
   * The manifest repository NAME for a recorded repo value — the receipt names
   * the service the way Settings names it, never the path. Absent → the
   * display path stands.
   */
  repoNameFor?: (repo: string) => string | undefined;
  /**
   * The ticket's stage cells — the Timing strip's source. Every work stage
   * with both stamps contributes its span, and the total is their SUM over
   * the same stamps, so the strip's displayed total can never disagree with
   * the displayed stage durations (869egdr2u-fu1).
   */
  stages: readonly StepperCell[];
}

/** English plural, host-side. The webview never pluralises (UI-R31). */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The counted gates of ONE gate stage's final batch, evidence rows excluded. */
function finalBatch(gateRuns: readonly GateRun[], stage: 'uat' | 'review'): GateRun[] {
  return latestBatch(gateRuns, stage).filter((r) => r.gateName !== CHANGES_GATE);
}

/**
 * The validation block: which gate stages answered, and how the final batch
 * of each read. A stage with no recorded batch is OMITTED — an unasked gate
 * stage is absence, never a pass.
 */
function validatedBlock(input: DoneReceiptInput): ReceiptBlockView {
  const uat = finalBatch(input.gateRuns, 'uat');
  const review = finalBatch(input.gateRuns, 'review');
  const verdicts = ([['UAT', uat], ['Review', review]] as const)
    .filter(([, batch]) => batch.length > 0)
    .map(([name, batch]) =>
      batch.some((r) => r.exitCode !== null && r.exitCode !== 0) ? `${name} failed` : `${name} passed`,
    );
  const batch = [...uat, ...review];
  const passed = batch.filter((r) => r.exitCode === 0).length;
  const failed = batch.filter((r) => r.exitCode !== null && r.exitCode !== 0).length;
  const details: string[] = [];
  if (passed > 0) details.push(`${plural(passed, 'final gate check', 'final gate checks')} passed`);
  if (failed > 0) details.push(`${plural(failed, 'final gate check', 'final gate checks')} failed`);
  if (input.rounds.length > 0) {
    details.push(`${plural(input.rounds.length, 'recovery round', 'recovery rounds')} before delivery`);
  }
  return {
    label: 'Validated',
    // Absence is stated, never dressed as a pass: a ticket whose gate stages
    // recorded nothing says so.
    value: verdicts.length > 0 ? verdicts.join(' · ') : 'No gate run recorded',
    details,
  };
}

/**
 * The AI-usage block. A ticket with no MEASURED spend states the absence —
 * a zero would read as a measured free ticket (decision 8). The input/output
 * split renders only when both directions were recorded and non-zero, the
 * same rule the implementation footer applies.
 */
function usageBlock(input: DoneReceiptInput): ReceiptBlockView {
  if (input.tokens === null) {
    return { label: 'AI usage', value: 'No token usage recorded yet', details: [] };
  }
  const details =
    input.tokens.input > 0 && input.tokens.output > 0
      ? [`${formatTokens(input.tokens.input)} input · ${formatTokens(input.tokens.output)} output`]
      : [];
  const breakdown: ReceiptBreakdownItem[] = input.roles.map((role) => ({
    amount: formatTokens(role.total),
    label: role.role,
  }));
  return {
    label: 'AI usage',
    value: `${formatTokens(input.tokens.total)} recorded tokens`,
    details,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
}

/** The work stages the Timing strip sums, in workflow order. */
const TIMING_STAGES: readonly StageKey[] = ['scope', 'impl', 'uat', 'review', 'ship', 'fix'];

/**
 * The Timing strip (869egdr2u-fu1): each work stage's span and the TOTAL as
 * their sum, both read from the SAME stage cells — so the strip's stated
 * total equals the sum of its stated durations by construction. A stage
 * without both stamps contributes nothing; a ticket with no stamped stage
 * gets no strip at all.
 */
function timingStrip(input: DoneReceiptInput): { label: string; total: string; items: string } | undefined {
  const spans: Array<{ label: string; ms: number }> = [];
  for (const key of TIMING_STAGES) {
    const cell = input.stages.find((c) => c.stageKey === key);
    if (!cell?.startedAt || !cell.endedAt) continue;
    const ms = Date.parse(cell.endedAt) - Date.parse(cell.startedAt);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    spans.push({ label: STAGE_TITLES[key], ms });
  }
  if (spans.length === 0) return undefined;
  const total = spans.reduce((sum, s) => sum + s.ms, 0);
  return {
    label: 'Timing',
    total: `${formatSpanMs(total)} total`,
    items: spans.map((s) => `${s.label} ${formatSpanMs(s.ms)}`).join(' · '),
  };
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

  // The delivery lines name the repository and carry its PR number as the
  // row's own link — the number is a resource identifier, so it IS the control
  // (UI-R09c), the same reading the ship rows give it. A PR whose id the host
  // never minted an action for renders the number as plain text.
  const mergedRows = merged.map((pr): EvidenceRow => {
    const label = input.repoNameFor?.(pr.repo) ?? (pr.repoDisplay || pr.repo);
    const action = pr.id ? input.attach?.({ kind: 'open-pr', prId: pr.id }) : undefined;
    return {
      status: 'pass',
      label,
      detail: pr.number ? `#${pr.number}` : 'merged',
      ...(pr.status ? { prState: pr.status } : {}),
      ...(action ? { action } : {}),
      // Each merged row dates from its own merge stamp (Task 869egdr2u).
      ...(pr.mergedAt ? { time: formatTime(pr.mergedAt) } : {}),
    };
  });
  const repositoryRows = boundedEvidenceRows(
    mergedRows,
    REPOSITORY_EVIDENCE_LIMIT,
    input.attach
      ? (allRows) =>
          input.attach?.({
            kind: 'open-bounded-evidence',
            title: 'Done · Delivery receipt',
            rows: allRows,
            // handoff §10: the continuation says exactly what it reveals.
            label: `Show ${Math.max(0, allRows.length - REPOSITORY_EVIDENCE_LIMIT)} more`,
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
    // handoff §11: absence is stated, never a zero — "No token usage recorded
    // yet" names the empty fact instead of omitting it in silence.
    ...(input.tokens === null
      ? [{ status: 'note', label: 'tokens', detail: 'No token usage recorded yet' } satisfies EvidenceRow]
      : []),
    ...input.roles.map(
      (role): EvidenceRow => ({
        status: 'note',
        label: role.role,
        detail: formatTokens(role.total),
      }),
    ),
  ];

  const timing = timingStrip(input);

  return {
    status: 'complete',
    // The process-row description, dynamic per state: what the receipt
    // actually delivers. Zero merged reads as "no pull requests merged" —
    // never a fabricated "0 delivered".
    detail:
      merged.length > 0
        ? `${plural(merged.length, 'current pull request', 'current pull requests')} merged`
        : 'no pull requests merged',
    delivered: { repos: merged.length, prs: merged.length, commits },
    validated,
    tokens:
      input.tokens === null
        ? null
        : { label: `${formatTokens(input.tokens.total)} tokens recorded` },
    evidence: {
      kind: 'receipt',
      rows,
      hero: {
        title: 'Delivered',
        // Only what merged CURRENT PRs and ship commits actually say. The
        // gate wording lives in its own block; repeating it here would put
        // two claims about validation on one screen.
        summary: `${plural(merged.length, 'repository', 'repositories')} · ${plural(
          merged.length,
          'pull request',
          'pull requests',
        )} merged`,
        // An unrecorded completion stamp is an EMPTY time, never `now`.
        time: input.completedAt ? `completed ${formatTime(input.completedAt)}` : '',
      },
      blocks: [
        {
          label: 'Delivered',
          value: `${plural(merged.length, 'pull request', 'pull requests')} merged`,
          details: [
            plural(merged.length, 'repository', 'repositories'),
            `${plural(commits, 'commit', 'commits')} created by ship`,
          ],
        },
        validatedBlock(input),
        usageBlock(input),
      ],
      ...(timing ? { timing } : {}),
    },
  };
}
