import type { Store } from '../../store/db.js';
import { getPlacement } from '../../store/placement.js';
import { getTicket, setSessionId } from '../../store/tickets.js';
import { latestSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import type { AgentProvider } from '../../manifest/types.js';

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'];
const asProvider = (raw: string): AgentProvider | undefined => PROVIDERS.find((p) => p === raw);

export interface HostSessionRepairDeps {
  readonly store: Store;
  /** Ids of this project's live (non-archived, not done+merged) tickets. */
  readonly live: () => readonly number[];
  readonly owns: (ticketId: number) => boolean;
  readonly info: (message: string) => void;
}

/**
 * Boot repair for T1121: before the placement fix, a reload cleared `session_id`,
 * `session_provider` and `session_launch_id` of every live host ticket. Restore them from the
 * ticket's latest launch intent when, and only when, it is safe:
 *  - the recorded placement is host and this window controls the ticket;
 *  - `session_id` is NULL and an agent is live or was live (`agent_state` not none/not-started);
 *  - the latest launch intent of the ticket is confirmed with a provider session id, so no
 *    newer launch is pending or failed (that launch owns the binding).
 * A session the user dropped on purpose stays dropped unless the agent state shows it is live.
 * A stale restored id is self-healing: the agent CLI rejects `--resume` and `dropStaleResume`
 * clears it. Returns the repaired ticket ids; logs each one.
 */
export function repairHostSessions(deps: HostSessionRepairDeps): readonly number[] {
  const repaired: number[] = [];
  for (const id of deps.live()) {
    if (!deps.owns(id)) continue;
    if (getPlacement(deps.store, id)?.backend !== 'host') continue;
    const t = getTicket(deps.store, id);
    if (t.sessionId !== null) continue;
    if (t.agentState === null || t.agentState === 'none' || t.agentState === 'not-started') continue;
    const intent = latestSessionLaunchIntent(deps.store, id);
    if (intent === undefined || intent.status !== 'confirmed' || !intent.providerSessionId) continue;
    const provider = asProvider(intent.provider);
    if (provider === undefined) {
      deps.info(`karst: did not restore the session of host ticket ${id}: unknown provider "${intent.provider}"`);
      continue;
    }
    setSessionId(deps.store, id, intent.providerSessionId, provider, intent.launchId);
    deps.info(`karst: restored the session of host ticket ${id} (launch ${intent.launchId}) cleared by an earlier reload`);
    repaired.push(id);
  }
  return repaired;
}
