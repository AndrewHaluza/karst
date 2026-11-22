import type { Store } from '../../store/db.js';
import type { AgentProvider } from '../../manifest/types.js';
import { recordEvent } from '../../store/karstEvents.js';
import { getTicket } from '../../store/tickets.js';
import { isAgentProvider, quotaResetAt, type CarryLaneRole } from '../../workflow/carriedPick.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import type { Manifest } from '../../manifest/types.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

/**
 * T1313 (@arch:AC-65): the host seams of the carried usage-limit pick, kept
 * out of `extension.ts` (bindings only).
 */
export interface CarriedPickWiringDeps {
  store: Store;
  /** The project an Activity entry lands in when the ticket row has none. */
  fallbackProjectId: () => number | undefined;
  /** The quota module's snapshot for a core (`QuotaService.get`). */
  quotaFor: (core: AgentProvider) => QuotaSnapshot | undefined;
  debug: (message: string) => void;
  now?: () => Date;
  manifest: () => Manifest;
  catalog: () => ModelCatalog;
}

export interface CarriedPickWiring {
  /** One Activity entry for a lane that ran on a carry. */
  carryActivity: (ticketId: number, title: string) => void;
  /** The quota window reset for a core, or null when unknown. */
  quotaResetFor: (provider: string) => string | null;
  /**
   * The role's resolved provider WITHOUT building an adapter — the same
   * ticket picks as the host `processFor`, read by the lane guard first.
   */
  laneProvider: (ticketId: number, role: CarryLaneRole) => string | null;
}

export function makeCarriedPickWiring(deps: CarriedPickWiringDeps): CarriedPickWiring {
  return {
    carryActivity: (ticketId, title) => {
      let projectId: number | null | undefined;
      try {
        projectId = getTicket(deps.store, ticketId).projectId ?? deps.fallbackProjectId();
      } catch (err) {
        deps.debug(`[driver] ticket ${ticketId}: carried-pick Activity skipped: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (projectId === undefined || projectId === null) {
        deps.debug(`[driver] ticket ${ticketId}: no project for the carried-pick Activity entry (${title})`);
        return;
      }
      recordEvent(deps.store, { projectId, ticketId, level: 'info', source: 'host', title }, deps.debug);
    },
    laneProvider: (ticketId, role) => {
      const t = getTicket(deps.store, ticketId);
      const picks = {
        provider: t.agentProvider ?? undefined,
        model: t.model || undefined,
        effort: t.effort || undefined,
        preset: t.agentPreset ?? undefined,
      };
      return resolveProcessAssignment(deps.manifest(), role, picks, deps.catalog())?.provider ?? null;
    },
    quotaResetFor: (provider) =>
      isAgentProvider(provider) ? quotaResetAt(deps.quotaFor(provider), deps.now?.() ?? new Date()) : null,
  };
}
