import { buildArtifactsFrom, readPlanInput } from '../../model/artifacts.js';
import { countShipRuns } from '../../store/shipRuns.js';
import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { listFindings, findingsForAttempt } from '../../store/reviewFindings.js';
import { listImplementationTimeline, readSegmentTokenTotals } from '../../store/implementationRuns.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listPhaseMarks } from '../../store/phaseMarks.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { listStageRuns } from '../../store/stageRuns.js';
import { listUatFindings } from '../../store/uatFindings.js';
import { listShipEvidence } from '../../store/shipRuns.js';
import { summarizeRecordedTokenUsageForProcess } from '../../store/tokenUsage.js';
import type { ServerView } from '../../store/dashboard.js';
import type { ServiceStatusView } from '../../model/inside/gates.js';
import type { InsideActionRegistry } from './insideActions.js';
import type { InsideEvidenceTarget, TypedInsideAction } from '../../model/inside/types.js';
import type { SessionTokensInput } from '../../model/inside/agent.js';

type Ticket = ReturnType<typeof getTicket>;

// The snapshot-scoped action seam: the registry lives here in the host; only
// the opaque {actionId, kind} pairs ride the view. The continuation label
// ("Show 4 more", handoff §10) is presentation copy the registry does not
// model, so it is carried alongside the minted action here.
export function buildAttach(
  registry: InsideActionRegistry | null | undefined,
  ticketId: number,
): (target: InsideEvidenceTarget) => TypedInsideAction | undefined {
  return (target) => {
    const action = registry?.register({ ...target, ticketId });
    if (!action) return undefined;
    const label = 'label' in target ? (target as { label?: string }).label : undefined;
    return label ? { ...action, label } : action;
  };
}

// Recorded token summaries per process and per role — a process whose calls
// were all estimates reads as absent, never as a measured free call. The
// estimate COUNT rides beside the measured total as a separate fact (a core
// that fell back to estimates stays visible, never folded into the total).
// Gated on FRESH spend, not the raw tally: the pill headlines fresh (see
// `tokenView`), so a process whose every recorded token was a cache READ has
// a raw total > 0 but nothing fresh, and admitting it here renders a
// clamped "0 tok" — a fabricated zero, which decision 8 forbids (absence is
// stated, never a measured-looking nothing). Same rule as the segment
// timeline's filter in `model/inside/agent.ts`.
export function buildTokensFor(
  store: Store,
  ticketId: number,
): (processId: string) => SessionTokensInput | null {
  return (processId) => {
    const summary = summarizeRecordedTokenUsageForProcess(store, ticketId, processId);
    return summary.total - summary.cacheRead > 0
      ? {
          total: summary.total,
          cacheRead: summary.cacheRead,
          estimatedCalls: summary.estimatedCalls,
        }
      : null;
  };
}

// Per-segment measured spend, straight from the ledger's own
// `implementation_segment_id` GROUP BY — the switch row's Σ pill states what
// the segment it moved TO went on to cost. A run that never opened has no
// segments and therefore no totals.
export function readSegmentTokens(
  store: Store,
  timeline: ReturnType<typeof listImplementationTimeline>,
) {
  return timeline
    ? readSegmentTokenTotals(store, timeline.run.id).map((t) => ({
        implementationSegmentId: t.implementationSegmentId,
        total: t.totalTokens,
        cacheRead: t.cacheReadTokens,
      }))
    : [];
}

// Ruling (fix round 1, overriding the brief's `latestFindingBatch`):
// findings are append-only with no resolve path, and a clean re-review
// records NO batch at all (`workflow/gates/evidence.ts`'s early return
// on zero findings). `latestFindingBatch`'s greatest-`runAt` reduction
// therefore keeps re-surfacing a fixed-and-passed ticket's stale batch
// forever — it is never superseded by an empty one that was never
// written. Scoped to the review STAGE's CURRENT `attempt` instead:
// `attempt` only climbs on a FAILED verdict (`workflow/machine.ts`) and
// holds on a pass, so a fail-then-fix-then-pass re-review shares its
// attempt number with the fail it followed — the fail's findings are
// still "this attempt"'s findings, and a LATER attempt (a fresh fail)
// silently drops them, exactly the "cleared" reading a permanent-noise
// row cannot give.
//
// Intended reach (deliberate, not an oversight): because `attempt`
// climbs only on a failed verdict, this row is SILENT on the ordinary
// fail→fix→clean-pass path — and a ticket with unresolved
// current-attempt blocking findings cannot reach ship anyway, since R6
// fails review first. The row is a BACKSTOP, not the primary gate: it
// catches a `review.findings.blockingSeverity` threshold lowered AFTER
// the review passed, and a ticket advanced to ship by hand. The
// attempt scoping is the trade that buys that backstop without a
// permanent, unclearable false-red row (see the ruling above).
export function readShipFindings(store: Store, ticket: Ticket) {
  return findingsForAttempt(
    store,
    ticket.id,
    ticket.stages.find((s) => s.stageKey === 'review')?.attempt ?? 0,
  );
}

// The evidence reads of one snapshot, in their fixed order.
export function readEvidence(store: Store, ticketId: number) {
  // ONE read of the marks, for the same reason — the Inside strip and the impl
  // segment's pips are two views of one set of facts.
  const marks = listPhaseMarks(store, ticketId);
  // ONE read of each inside evidence source, shared by every view that renders
  // it — two reads of one table is how two panels disagree about one fact.
  const gateRuns = listGateRuns(store, ticketId);
  const findings = listFindings(store, ticketId);
  const processRuns = listProcessRuns(store, ticketId);
  const uatFindings = listUatFindings(store, ticketId);
  const shipEvidence = listShipEvidence(store, ticketId);
  const timeline = listImplementationTimeline(store, ticketId);
  // ONE read of the invocation records, for the same reason as every other
  // evidence read here. `stage_runs` is the only table written at stage ENTRY,
  // so it is the only thing that can say a gate stage is on a NEW invocation
  // that has recorded nothing yet — the fix cycle's round 2, which every
  // finished-work table still answers with round 1's rows.
  const stageRuns = listStageRuns(store, ticketId);
  return { marks, gateRuns, findings, processRuns, uatFindings, shipEvidence, timeline, stageRuns };
}

// The Services process rows: one per server row, with the boot-failure reason
// attached to a failed one.
export function serviceStatusViews(
  serverRows: readonly ServerView[],
  serviceFailureReason: string | null,
): ServiceStatusView[] {
  return serverRows.map((s) => ({
    service: s.service,
    status: s.status === 'running' || s.status === 'failed' ? s.status : 'stopped',
    host: s.host,
    port: s.port,
    ...(s.status === 'failed' && serviceFailureReason !== null
      ? { reason: serviceFailureReason }
      : {}),
  }));
}

// Derived from the SAME evidence reads as the rest of the snapshot (one read
// per table per snapshot): the artifacts shelf, the index, and the detail are
// three views of one set of facts, and two reads of one table is how two views
// of one fact disagree. Order = semantic priority; previews are the first three.
export function buildArtifacts(
  input: {
    store: Store;
    ticket: Ticket;
    phases: string[];
    marks: ReturnType<typeof readEvidence>['marks'];
    shipEvidence: ReturnType<typeof readEvidence>['shipEvidence'];
  } & Omit<
    Parameters<typeof buildArtifactsFrom>[0],
    'ship' | 'shipRunCount' | 'plan' | 'declaredPhases' | 'phaseMarks'
  >,
) {
  const { store, phases, marks, shipEvidence, ...rest } = input;
  return buildArtifactsFrom({
    ...rest,
    ship: shipEvidence,
    shipRunCount: countShipRuns(store, input.ticket.id),
    plan: readPlanInput(store, input.ticket.id),
    // The session-phases plan reads the SAME one-read phase marks and
    // declared workflow the approach line above already resolved — two reads
    // of one table is how two panels describe one plan differently.
    declaredPhases: phases,
    phaseMarks: marks,
  });
}
