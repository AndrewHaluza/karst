import type { Store } from '../../store/db.js';
import { listServersByTicket } from '../../store/dashboard.js';
import { summarizeRecordedTokenUsage, summarizeRecordedTokenUsageByRole } from '../../store/tokenUsage.js';
import { graphInsideProcess, type GraphInsideInput } from '../../model/inside/graph.js';
import type { Severity } from '../../manifest/types.js';
import type { StepperCell } from '../../model/stepper.js';
import type { StageKey } from '../../model/types.js';
import type { SessionConfiguredInput } from '../../model/inside/agent.js';
import type { TypedInsideAction, InsideEvidenceTarget } from '../../model/inside/types.js';
import type { RoundWithDelivery } from '../../model/inside/recovery.js';
import { buildTokensFor, readSegmentTokens, readShipFindings, serviceStatusViews, type readEvidence } from './stateEvidence.js';
import { buildGateSwitches } from './stateGates.js';
import { buildInsideViews } from './stateInside.js';
import type { DashboardState } from './stateTypes.js';
import type { getTicket } from '../../store/tickets.js';

export interface InsideSectionInput {
  ticket: ReturnType<typeof getTicket>;
  stepper: StepperCell[];
  currentStage: StepperCell | null;
  rounds: RoundWithDelivery[];
  worktrees: DashboardState['worktrees'];
  prs: Parameters<typeof buildInsideViews>[0]['prs'];
  mergeChecks: Parameters<typeof buildInsideViews>[0]['mergeChecks'];
  now: string;
  evidence: ReturnType<typeof readEvidence>;
  cellOf: (key: StageKey) => StepperCell;
  attach: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
  assignmentFor: (processId: 'session' | 'tester' | 'review') => SessionConfiguredInput | null;
  resolvedGates?: Parameters<typeof buildInsideViews>[0]['resolvedGates'];
  findingsRepoSelection?: Partial<Record<'uat' | 'review', string>>;
  repoNameFor: (repo: string) => string | undefined;
  graphInside?: GraphInsideInput | null;
  attemptSelection?: Partial<Record<'uat' | 'review', string>>;
  findingsBlockingSeverity: Severity | 'none';
  displayBlocking?: { review?: Severity | 'none'; tester?: Severity | 'none' };
}

/**
 * The six-stage inside presentation of one snapshot, with the reads it alone
 * needs (token totals, segment spend, ship findings, server rows) in their
 * fixed order. Returns the server rows too: the Servers panel shares them.
 */
export function buildInsideSection(store: Store, input: InsideSectionInput) {
  const {
    ticket, stepper, currentStage, rounds, worktrees, prs, mergeChecks, now, evidence, cellOf, attach,
    assignmentFor, resolvedGates, findingsRepoSelection, repoNameFor, graphInside, attemptSelection,
    findingsBlockingSeverity, displayBlocking,
  } = input;
  const { marks, gateRuns, findings, processRuns, uatFindings, shipEvidence, timeline, stageRuns } = evidence;
  const tokensFor = buildTokensFor(store, ticket.id);
  const recordedTotal = summarizeRecordedTokenUsage(store, ticket.id);
  const roleTokens = summarizeRecordedTokenUsageByRole(store, ticket.id);

  // Computed once: this used to be called separately by the spread's guard
  // and its element, building the whole projection twice and discarding one.
  const graphInsideProcessOnce = graphInsideProcess(graphInside);

  const {
    presentedStage,
    uatCurrent,
    reviewCurrent,
    uatSwitch,
    reviewSwitch,
    uatRoundSwitcher,
    reviewRoundSwitcher,
  } =
    buildGateSwitches({
      ticket,
      rounds,
      gateRuns,
      processRuns,
      stageRuns,
      cellOf,
      attemptSelection,
    });

  const segmentTokens = readSegmentTokens(store, timeline);
  const shipFindings = readShipFindings(store, ticket);

  // ONE read of the ticket's server rows, shared by the dashboard's Servers
  // panel and UAT's Services process. UAT's `boot-failed` reason is the health
  // evidence a failed row shows (a failed start's row carries no reason column).
  const serverRows = listServersByTicket(store, ticket.id);
  const serviceFailureReason =
    currentStage?.blocked?.kind === 'boot-failed' ? currentStage.blocked.reason : null;

  // ONE projection of the six-stage inside presentation, from the same
  // evidence reads above (one read per table per snapshot). Every input is
  // host-resolved here; `stateInside.ts` is a pure projection.
  const insideViews = buildInsideViews({
    cellOf,
    selectedRepos: ticket.selectedRepos,
    worktrees,
    // The ticket's own `agent_state === 'waiting'` — the agent asked the user a
    // question and is blocked on the answer. Threaded in explicitly, never
    // re-derived: it is the same fact `cli/stage.ts`'s
    // `assertMarkerNotWhileWaiting` refuses the done marker on.
    agentWaiting: ticket.agentState === 'waiting',
    now,
    processRuns,
    timeline,
    segmentTokens,
    marks,
    assignmentFor,
    tokensFor,
    attach,
    gateRuns,
    findings,
    uatFindings,
    rounds,
    services: serviceStatusViews(serverRows, serviceFailureReason),
    resolvedGates,
    findingsRepoSelection,
    repoNameFor,
    graphInsideProcessOnce,
    uatSwitch,
    reviewSwitch,
    uatRoundSwitcher,
    reviewRoundSwitcher,
    uatCurrent,
    reviewCurrent,
    shipEvidence,
    prs,
    mergeChecks,
    shipFindings,
    findingsBlockingSeverity,
    reviewBlockingSeverity: displayBlocking?.review,
    testerBlockingSeverity: displayBlocking?.tester,
    stepper,
    recordedTotal,
    roleTokens,
    stageCurrent: ticket.stageCurrent,
  });

  return { insideViews, presentedStage, serverRows };
}
