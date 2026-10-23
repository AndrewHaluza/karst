import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { AgentSwitchOutcome } from '../../agent/sessionSwitch.js';
import { claimUsageLimitPark, listOpenParks } from '../../store/usageLimitParks.js';

export interface InteractiveParkActionDeps {
  store: Store;
  /** The core → model picker; undefined when the user backs out. */
  pick: (
    parkedProvider: string,
    parkedModel: string | null,
  ) => Promise<{ provider: AgentProvider; model: string | null } | undefined>;
  /** The header switch (`applyAgentSwitchSelection`): own confirm, persists the choice. */
  switchSession: (
    ticketId: number,
    selection: { provider: AgentProvider; model: string | null },
  ) => Promise<AgentSwitchOutcome | undefined>;
  /** Relaunch the current session on the same core/model (`karst.openSession`). */
  relaunch: (ticketId: number) => Promise<void>;
}

/**
 * D160 actions on an open `interactive` park. Unlike D159's one-shot headless
 * re-run, Pick is a PERSISTED session switch (the header switch), so the claim
 * comes AFTER the switch succeeds: any non-`switched` outcome leaves the row
 * (and the prompt) open.
 */
export function makeInteractiveParkActions(deps: InteractiveParkActionDeps) {
  const findOpen = (ticketId: number, parkId: number) =>
    listOpenParks(deps.store, ticketId).find((p) => p.kind === 'interactive' && p.id === parkId) ?? null;
  return {
    async pickAgent(ticketId: number, parkId: number): Promise<'switched' | 'open' | 'gone'> {
      const park = findOpen(ticketId, parkId);
      if (!park) return 'gone';
      const chosen = await deps.pick(park.provider, park.model);
      if (!chosen) return 'open';
      const outcome = await deps.switchSession(park.ticketId, chosen);
      if (outcome?.kind !== 'switched') return 'open';
      claimUsageLimitPark(
        deps.store,
        parkId,
        `switched:${chosen.provider}/${chosen.model ?? 'default'}`,
      );
      return 'switched';
    },
    async retrySame(ticketId: number, parkId: number): Promise<'retried' | 'gone'> {
      const park = findOpen(ticketId, parkId);
      if (!park) return 'gone';
      await deps.relaunch(park.ticketId);
      claimUsageLimitPark(deps.store, parkId, 'retry');
      return 'retried';
    },
  };
}

export const PICK_LABEL = 'Pick agent/model…';
export const RETRY_LABEL = 'Retry same';
export const DISMISS_LABEL = 'Dismiss';

export interface InteractiveOfferDeps {
  store: Store;
  ticketId: number;
  parkId: number;
  actions: ReturnType<typeof makeInteractiveParkActions>;
  /** Show the prompt; undefined when the user closes it. */
  ask: (actions: readonly string[]) => Promise<string | undefined>;
}

/**
 * The prompt loop: a Pick that did not switch (cancelled picker, stale,
 * unavailable, launch-failed) keeps the row open AND the prompt available, so
 * it asks again; closing the prompt leaves the row open without nagging.
 */
export async function runInteractiveOffer(deps: InteractiveOfferDeps): Promise<void> {
  for (;;) {
    const choice = await deps.ask([PICK_LABEL, RETRY_LABEL, DISMISS_LABEL]);
    if (choice === PICK_LABEL) {
      if ((await deps.actions.pickAgent(deps.ticketId, deps.parkId)) === 'open') continue;
      return;
    }
    if (choice === RETRY_LABEL) {
      await deps.actions.retrySame(deps.ticketId, deps.parkId);
    } else if (choice === DISMISS_LABEL) {
      claimUsageLimitPark(deps.store, deps.parkId, 'dismissed');
    }
    return;
  }
}
