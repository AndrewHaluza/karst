import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { AgentProvider } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import type { AgentSwitchOutcome } from '../agent/sessionSwitch.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentIdentity.js';
import { getTicket } from '../store/tickets.js';
import { recordInteractiveUsageLimit } from './ops/interactiveUsageLimitOps.js';
import { makeInteractiveParkActions, runInteractiveOffer } from './ops/interactiveUsageLimitActions.js';

export interface InteractiveUsageLimitBindingDeps {
  store: Store;
  /** The core → model QuickPick (`makeUsageLimitAgentModelPicker`). */
  pick: Parameters<typeof makeInteractiveParkActions>[0]['pick'];
  /** The header switch; resolves to its outcome so the claim can follow it. */
  switchSession: (
    ticketId: number,
    selection: { provider: AgentProvider; model: string | null },
  ) => Promise<AgentSwitchOutcome | undefined>;
  /** Close the live session and reopen it on the same core/model. */
  relaunch: (ticketId: number) => Promise<void>;
  sessionProviderFor: (ticketId: number) => AgentProvider | null;
  refresh: (ticketId: number) => void;
}

/** D160: the host seam both the hook endpoint and the Claude transcript watch report into. */
export function createInteractiveUsageLimitBinding(deps: InteractiveUsageLimitBindingDeps) {
  const actions = makeInteractiveParkActions({
    store: deps.store,
    pick: deps.pick,
    switchSession: deps.switchSession,
    relaunch: deps.relaunch,
  });
  return {
    report(ticketId: number, sessionId: string, text: string, provider = deps.sessionProviderFor(ticketId)): void {
      if (!provider) return;
      const ticket = getTicket(deps.store, ticketId);
      recordInteractiveUsageLimit(
        {
          store: deps.store,
          offer: (parkId) => {
            deps.refresh(ticketId);
            void runInteractiveOffer({
              store: deps.store,
              ticketId,
              parkId,
              actions,
              ask: (labels) =>
                Promise.resolve(
                  vscode.window.showWarningMessage(
                    `${ticket.key}: ${AGENT_PROVIDER_LABELS[provider] || provider} hit its usage limit.`,
                    ...labels,
                  ),
                ),
            }).finally(() => deps.refresh(ticketId));
          },
        },
        {
          ticketId,
          sessionId,
          provider,
          model: ticket.model || null,
          stage: (ticket.stageCurrent ?? null) as StageKey | null,
          text,
        },
      );
    },
  };
}
