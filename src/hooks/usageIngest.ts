import type { Store } from '../store/db.js';
import { appendInteractiveUsageSample } from '../store/interactiveUsageSamples.js';
import { normalizeInteractiveUsage } from '../agent/interactiveUsage.js';
import { nowIso } from '../model/time.js';
import type { AgentProvider } from '../manifest/types.js';

/**
 * The shared append step of a closed `UsageUpdate` (Task 5, T1370). The caller
 * resolved the ticket and the provider of the session that emitted the sample:
 * the ticket path from the worktree and the ticket session, the graph path from
 * the running graph process run. This step narrows the untrusted usage payload
 * and appends the cumulative sample; the store binds it to the owned process.
 * Usage is not a liveness signal — no agent_state is written. Returns true only
 * when displayed spend changed.
 */
export function recordUsageSample(
  store: Store,
  input: {
    ticketId: number;
    provider: AgentProvider;
    providerSessionId: string;
    usage: unknown;
  },
  debug?: (msg: string) => void,
): boolean {
  const { ticketId, provider, providerSessionId } = input;
  const normalized = normalizeInteractiveUsage(input.usage);
  if (normalized === null) {
    debug?.(`[usage] ticket ${ticketId}: malformed usage payload`);
    return false;
  }
  debug?.(`[usage] ticket ${ticketId}: provider=${provider}, session=${providerSessionId}, input=${normalized.input}, output=${normalized.output}`);
  const result = appendInteractiveUsageSample(store, {
    ticketId,
    sample: {
      ...normalized,
      provider,
      providerSessionId,
      observedAt: nowIso(),
    },
  });
  debug?.(`[usage] ticket ${ticketId}: append result=${result.kind}`);
  return result.kind === 'recorded';
}
