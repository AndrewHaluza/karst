import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listPrsByTicket,
  type ServerView,
  type WorktreeView,
  type PrView,
} from '../../store/dashboard.js';
import type { TicketProvider } from '../../manifest/types.js';
import { providerTicketUrl } from '../../integrations/ticketUrl.js';
import { buildStepper, type StepperCell } from '../../model/stepper.js';
import { buildNowLine, type NowLine } from '../../model/nowLine.js';
import { sessionAction } from '../../agent/sessionAction.js';
import { buildStageRail, type StageRail } from '../../model/stageRail.js';
import { buildStageInside, type StageInside } from '../../model/inside/index.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listPhaseMarks } from '../../store/phaseMarks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { nowIso } from '../../model/time.js';
import type { StageKey } from '../../model/types.js';
import { countFixAttempts } from '../../workflow/fixAttempts.js';
import { repoDisplayPath, type PathContext } from '../worktreePath.js';

export type { PathContext, StepperCell, NowLine, StageRail, StageInside };

/** Fully serializable dashboard state pushed to the webview via postMessage. */
export interface DashboardState {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  stepper: StepperCell[];
  /**
   * The stepper cell the ticket currently sits on — the one the "Now" line and
   * the fault card describe. Null when the ticket sits at no stage at all.
   */
  currentStage: StepperCell | null;
  /**
   * One plain sentence naming what is happening and the next action the user
   * controls. Built host-side because the webview is standalone HTML and cannot
   * import the copy module — shipping it keeps a single, tested source.
   */
  now: NowLine;
  servers: ServerView[];
  /** False when nothing in scope declares a service — nothing can ever start. */
  hasRunnableRepos: boolean;
  worktrees: WorktreeView[];
  prs: PrView[];
  /** Configured ticketing provider ('clickup' | 'manual'); null when unknown. */
  provider: string | null;
  /** The board ref the ticket was fetched from, or null. */
  sourceRef: string | null;
  /** External board URL for the ticket, or null (manual/unfetched → no link). */
  ticketUrl: string | null;
  /** Synthesized context brief, shown as a hover on the provider link; or null. */
  brief: string | null;
  /**
   * The stage graph as it is drawn: the forward path, plus the fix return
   * channel that hangs below it. `stepper` above stays the flat canonical
   * projection; this is the shape the rail renders.
   */
  rail: StageRail;
  /**
   * What happens inside each stage — observed operations for a stage that ran or
   * is running, a static blurb for one that has not. All seven are precomputed
   * so clicking a stage re-points the panel without a round trip to the host.
   */
  inside: Record<StageKey, StageInside>;
  /**
   * The approach driving impl, and the workflow phases it DECLARES. The phases
   * carry no per-phase state and never will: impl exposes no deterministic
   * sub-signal (the no-inference guarantee), so they describe what the agent was
   * asked to do, not what karst watched it do.
   */
  approach: { id: string; phases: string[] } | null;
}

/**
 * Gather everything a ticket dashboard renders, in one snapshot. The stepper is
 * ordered by STAGE_KEYS (not by stage-row insertion) so the stepper is stable.
 * Throws if the ticket id is unknown (validated at the boundary).
 */
export function buildDashboardState(
  store: Store,
  ticketId: number,
  pathContext?: PathContext,
  ticketing?: { provider?: TicketProvider },
  /**
   * Resolve an approach id to its ordered workflow phase names (host binds this
   * to the installed package's `workflow`). Injected so this stays pure/testable.
   */
  approachPhases: (approachId: string | null) => string[] = () => [],
  /**
   * Whether a scoped repository declares a runnable service. Injected (the state
   * builder never reads the manifest) and defaults to "assume runnable", so a
   * caller that cannot resolve the manifest degrades to the previous behavior
   * rather than hiding a working button.
   */
  isRepoRunnable: (repo: string) => boolean = () => true,
): DashboardState {
  const ticket = getTicket(store, ticketId); // throws on unknown id
  const stepper = buildStepper(ticket.stages);
  const currentStage = stepper.find((c) => c.stageKey === ticket.stageCurrent) ?? null;

  const worktrees = listWorktreesByTicket(store, ticketId).map((w) => ({
    ...w,
    repoDisplay: repoDisplayPath(w.repo, pathContext),
  }));

  const fixAttempts = countFixAttempts(ticket.stages);
  const prs = listPrsByTicket(store, ticketId);
  const phases = approachPhases(ticket.approach);

  return {
    ticketId: ticket.id,
    key: ticket.key,
    title: ticket.title,
    stageCurrent: ticket.stageCurrent,
    agentState: ticket.agentState,
    stepper,
    currentStage,
    now: buildNowLine(currentStage, {
      fixAttempts,
      sessionAction: sessionAction(ticket),
    }),
    servers: listServersByTicket(store, ticketId),
    // Drives whether "Start servers" is offered at all. A ticket scoping only
    // non-runnable repositories can never have a server, so presenting a live
    // Start button there is a dead affordance dressed as an available action.
    hasRunnableRepos: ticket.selectedRepos.some((r) => isRepoRunnable(r)),
    worktrees,
    prs,
    provider: ticketing?.provider ?? null,
    sourceRef: ticket.sourceRef,
    ticketUrl: providerTicketUrl(ticketing?.provider, ticket.sourceRef),
    brief: ticket.brief,
    rail: buildStageRail(stepper, fixAttempts),
    inside: buildStageInside({
      stepper,
      gateRuns: listGateRuns(store, ticketId),
      worktrees,
      prs,
      mergeChecks: listMergeChecksByTicket(store, ticketId),
      session: {
        sessionId: ticket.sessionId,
        agentState: ticket.agentState,
        model: ticket.model,
      },
      selectedRepos: ticket.selectedRepos,
      phases,
      marks: listPhaseMarks(store, ticketId),
      fixAttempts,
      now: nowIso(),
    }),
    approach: ticket.approach ? { id: ticket.approach, phases } : null,
  };
}
