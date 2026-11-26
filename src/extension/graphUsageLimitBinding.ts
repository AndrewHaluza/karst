/**
 * T1380 — the host seam that parks a graph node/planner on its provider usage
 * limit and asks the person what to do.
 *
 * The signal arrives twice: from an opencode/opencode2 `session.error` hook
 * (`GraphLaunchOwner`) and from the Claude host transcript sweep
 * (`GraphClaudeUsageLimitSignal`). Both land here as one `GraphUsageLimitSignal`.
 *
 * The durable park is `parkGraphUsageLimit` (@arch:GRAPH-AUTORECOVERY): one
 * transaction blocks the role row and the graph run, releases a process slot
 * and (after commit) terminates the session through the transport. Only the
 * window that wins the park CAS offers the prompt, so a reload or a second
 * signal for an already-blocked run never asks again.
 *
 * The prompt mirrors the interactive one (`runInteractiveOffer`):
 * Pick agent/model… (a QuickPick, then ONLY the parked role's snapshot entry is
 * replaced) → Resume; Retry same → Resume; Dismiss → the blocked banner keeps
 * Resume and Replan. Karst never switches a core or account by itself.
 */

import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import type { Manifest, GraphApproachConfig, AgentProvider } from '../manifest/types.js';
import { graphRunAgentIdentity, graphRunById } from '../store/graph/graphRuns.js';
import { graphRunProcessIdentity, type GraphLaunchOwner, type GraphSessionRole } from '../store/graph/sessionOwners.js';
import {
  GRAPH_ROLES,
  parseRunIdentities,
  resolveRunIdentities,
  type RoleIdentity,
  type GraphRole,
} from '../approaches/graph/runIdentity.js';
import {
  switchGraphRunModels,
  type SwitchModelsOutcome,
} from '../approaches/graph/modelChange.js';
import type { GraphLaunchTicketFields } from '../approaches/graph/profileResolver.js';
import { parkGraphUsageLimit } from '../approaches/graph/coordinator/usageLimitPark.js';
import { blockGraphStage } from '../workflow/graphMarkerGuard.js';
import type { SupervisedAgentSession, TerminationProof } from '../approaches/graph/transport/agentTransport.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './ops/graphRecoveryDispatch.js';
import { PICK_LABEL, RETRY_LABEL, DISMISS_LABEL } from './ops/interactiveUsageLimitActions.js';
import { ask, toast } from './toastSeam.js';
import { reasonText } from '../model/notifyText.js';

/** One usage-limit signal, either source, with the provider when known. */
export interface GraphUsageLimitSignal {
  ticketId: number;
  graphRunId: number;
  runId: number;
  role: GraphSessionRole;
  /** The parked core; null/absent reads from the role's running process run. */
  provider?: string | null;
  text: string;
}

/** The transport seam the park terminates through (attributable kill only). */
export interface GraphUsageLimitTransport {
  sessions(): readonly SupervisedAgentSession[];
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
}

export interface GraphUsageLimitBindingDeps {
  /** The graph coordinator store; resolved lazily (created after the hook endpoint). */
  store(): Store | undefined;
  transaction: <T>(fn: () => T) => T;
  now(): string;
  /** The live graph transport; resolved lazily (created after the hook endpoint). */
  transport(): GraphUsageLimitTransport | undefined;
  /** The recovery dispatch seams; resolved lazily. */
  recovery(): GraphRecoverySeams | undefined;
  /** The core → model picker (undefined when the user backs out). */
  pick(
    parkedProvider: string,
    parkedModel: string | null,
  ): PromiseLike<{ provider: AgentProvider; model: string | null } | undefined>;
  manifest(): Manifest | undefined;
  graphConfigOf(approachId: string): GraphApproachConfig | undefined;
  ticketLaunchFieldsOf(ticketId: number): GraphLaunchTicketFields;
  refresh(ticketId: number): void;
  debug(message: string): void;
  logError(message: string, error: unknown): void;
  /** The prompt seam; defaults to `ask.warn` from the toast seam. */
  ask?(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  /** The failure toast; defaults to `toast.error` from the toast seam. */
  toastError?(message: string): void;
}

export interface GraphUsageLimitBinding {
  /** Claude transcript sweep and any unified caller. */
  onGraphUsageLimit(signal: GraphUsageLimitSignal): Promise<void>;
  /** opencode/opencode2 hook `session.error` (`(owner, text)` callback shape). */
  onGraphHookUsageLimit(owner: GraphLaunchOwner, text: string): void;
}

/** The parked role from the process run's agent name, else the role's fallback. */
export function parkedGraphRole(role: GraphSessionRole, agentName: string | null): GraphRole {
  // Stryker disable next-line ConditionalExpression: equivalent — `includes(null)` is already false, so the `agentName !== null` half cannot change the result.
  if (agentName !== null && (GRAPH_ROLES as readonly string[]).includes(agentName)) {
    return agentName as GraphRole;
  }
  return role === 'planner' ? 'expert' : 'worker';
}

export function createGraphUsageLimitBinding(deps: GraphUsageLimitBindingDeps): GraphUsageLimitBinding {
  const warn = deps.ask ?? ((message: string, ...actions: string[]) => ask.warn(message, ...actions));
  const toastError = deps.toastError ?? ((message: string) => void toast.error(message));

  /** Terminate the parked session through the transport's attributable kill. */
  const terminateSession = async (target: {
    graphRunId: number;
    role: GraphSessionRole;
    runId: number;
  }): Promise<TerminationProof | undefined> => {
    const transport = deps.transport();
    if (!transport) return undefined;
    const session = transport
      .sessions()
      .find(
        (s) =>
          s.graphRunId === target.graphRunId &&
          s.nodeRunId === target.runId &&
          (s.runKind ?? 'node') === target.role,
      );
    if (!session) return undefined;
    return transport.terminate(session);
  };

  /** Replace ONLY the parked role in the run's snapshot, dropping stale effort. */
  const switchParkedRole = (
    store: Store,
    input: { ticketId: number; graphRunId: number; role: GraphRole; provider: AgentProvider; model: string | null },
  ): SwitchModelsOutcome | undefined => {
    const manifest = deps.manifest();
    if (!manifest) return undefined;
    const run = graphRunById(store.db, input.graphRunId);
    // Stryker disable next-line StringLiteral: equivalent — the caller treats every outcome but switched/unchanged the same, so '' and 'not-found' cannot differ here.
    if (!run) return 'not-found';
    const config = deps.graphConfigOf(run.approach_id);
    const snapshot =
      parseRunIdentities(graphRunAgentIdentity(store.db, input.graphRunId)) ??
      (config ? resolveRunIdentities(manifest, config, deps.ticketLaunchFieldsOf(input.ticketId)) : undefined);
    if (!snapshot) return undefined;
    const previous = snapshot.roles[input.role];
    const next: RoleIdentity = {
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      source: previous?.source ?? 'approach',
    };
    snapshot.roles[input.role] = next;
    return switchGraphRunModels(
      {
        db: store.db,
        transaction: deps.transaction,
        now: deps.now,
        debug: deps.debug,
        manifest,
        graphConfigOf: deps.graphConfigOf,
        ticketLaunchFieldsOf: deps.ticketLaunchFieldsOf,
      },
      input.graphRunId,
      snapshot,
    );
  };

  const resume = (ticketId: number, graphRunId: number): void => {
    const seams = deps.recovery();
    if (!seams) {
      deps.debug(`[graph] usage-limit: recovery seams not wired, run ${graphRunId} stays blocked`);
      return;
    }
    dispatchGraphRecovery(seams, { ticketId, graphRunId, mode: 'resume' });
  };

  const offer = async (input: {
    signal: GraphUsageLimitSignal;
    provider: string;
    model: string | null;
    parkedRole: GraphRole;
    label: string;
  }): Promise<void> => {
    for (;;) {
      const choice = await warn(input.label, PICK_LABEL, RETRY_LABEL, DISMISS_LABEL);
      if (choice === PICK_LABEL) {
        const chosen = await deps.pick(input.provider, input.model);
        // A cancelled picker keeps the park (and the prompt) available.
        if (!chosen) continue;
        const store = deps.store();
        if (!store) return;
        const outcome = switchParkedRole(store, {
          ticketId: input.signal.ticketId,
          graphRunId: input.signal.graphRunId,
          role: input.parkedRole,
          provider: chosen.provider,
          model: chosen.model,
        });
        if (outcome === 'switched') {
          resume(input.signal.ticketId, input.signal.graphRunId);
          return;
        }
        // Unchanged/terminal/not-found: let the user pick again or retry.
        if (outcome === 'unchanged') continue;
        return;
      }
      if (choice === RETRY_LABEL) {
        resume(input.signal.ticketId, input.signal.graphRunId);
        return;
      }
      // DISMISS_LABEL or a closed notification: the blocked banner keeps
      // Resume and Replan; the park is never lifted here.
      return;
    }
  };

  const binding: GraphUsageLimitBinding = {
    async onGraphUsageLimit(signal) {
      try {
        const store = deps.store();
        if (!store) {
          deps.debug('[graph] usage-limit: coordinator store is not wired, nothing parked');
          return;
        }
        const identity = graphRunProcessIdentity(store.db, signal.role, signal.runId);
        const provider = signal.provider ?? identity?.provider ?? null;
        if (provider === null) {
          deps.debug(
            `[graph] usage-limit: ${signal.role} run ${signal.runId} has no running process identity, nothing parked`,
          );
          return;
        }
        const model = identity?.model ?? null;
        const parkedRole = parkedGraphRole(signal.role, identity?.agentName ?? null);
        const result = await parkGraphUsageLimit(
          {
            store,
            transaction: deps.transaction,
            now: deps.now,
            debug: deps.debug,
            terminateSession,
          },
          {
            graphRunId: signal.graphRunId,
            role: signal.role,
            runId: signal.runId,
            provider,
            model,
            text: signal.text,
          },
        );
        // Another window won the park, or the run was already blocked: no
        // stage write, no refresh, and (critically) no second prompt.
        if (!result.parked) return;
        blockGraphStage(store, signal.ticketId, signal.graphRunId, deps.now);
        deps.refresh(signal.ticketId);

        const ticket = getTicket(store, signal.ticketId);
        const ticketKey = ticket.key || String(signal.ticketId);
        await offer({
          signal,
          provider,
          model,
          parkedRole,
          label: `Graph ${signal.role} of ${ticketKey} hit the ${provider} usage limit`,
        });
      } catch (error) {
        deps.logError('karst: graph usage-limit park failed', error);
        toastError(`Karst could not park the graph ${signal.role} on its usage limit (${reasonText(error)}).`);
      } finally {
        deps.refresh(signal.ticketId);
      }
    },
    onGraphHookUsageLimit(owner, text) {
      void binding.onGraphUsageLimit({
        ticketId: owner.ticketId,
        graphRunId: owner.graphRunId,
        runId: owner.runId,
        role: owner.role,
        provider: owner.provider,
        text,
      });
    },
  };
  return binding;
}
