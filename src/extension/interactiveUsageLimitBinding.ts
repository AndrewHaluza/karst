import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { AgentProvider } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import type { AgentSwitchOutcome } from '../agent/sessionSwitch.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentIdentity.js';
import { getTicket } from '../store/tickets.js';
import type { HookPayload } from '../hooks/dispatch.js';
import { claudeTrailingQuota, quotaTextFromHook } from '../agent/interactiveQuota.js';
import { makeOncePerError, recordInteractiveUsageLimit } from './ops/interactiveUsageLimitOps.js';
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
  /** Close the live session (Retry same reopens it on the same core/model). */
  disposeSession: (ticketId: number) => void;
  sessionProviderFor: (ticketId: number) => AgentProvider | null;
  refresh: (ticketId: number) => void;
}

/** D160: the host seam both the hook endpoint and the Claude transcript watch report into. */
export function createInteractiveUsageLimitBinding(deps: InteractiveUsageLimitBindingDeps) {
  const actions = makeInteractiveParkActions({
    store: deps.store,
    pick: deps.pick,
    switchSession: deps.switchSession,
    relaunch: async (ticketId) => {
      deps.disposeSession(ticketId);
      await vscode.commands.executeCommand('karst.openSession', ticketId, { allowResume: true, providerReady: true });
    },
  });
  const once = makeOncePerError();
  const binding = {
    /** Hook endpoint / bridge `session.error` (opencode cores). */
    onSessionError(ticketId: number, payload: HookPayload): void {
      const text = quotaTextFromHook(payload);
      if (text) binding.report(ticketId, payload.session_id ?? 'unknown', text);
    },
    /** A Claude transcript read; only a trailing API error counts. */
    onClaudeTranscript(ticketId: number, sessionId: string, transcript: string): void {
      const quota = claudeTrailingQuota(transcript);
      if (!quota || !once(ticketId, sessionId, quota.key)) return;
      binding.report(ticketId, sessionId, quota.text, 'claude');
    },
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
            })
              .catch((e: unknown) => {
                void vscode.window.showErrorMessage(
                  `${ticket.key}: usage-limit action failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              })
              .finally(() => deps.refresh(ticketId));
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
  return binding;
}
