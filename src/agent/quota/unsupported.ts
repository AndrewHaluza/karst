import type { AgentProvider } from '../../manifest/types.js';
import type { QuotaReader, QuotaSnapshot } from './types.js';

/**
 * The `unknown` reader (`arch:AC-29`).
 *
 * D162 probed every core for a zero-request quota source. Antigravity has none:
 * its subscription windows live in a provider backend (Google Cloud Quotas) with
 * no local telemetry file and no public zero-spend usage endpoint, so a probe
 * would cost a model request. OpenCode left this list in T720 — its Go plan
 * exposes `GET /zen/go/v1/usage` (`opencode.ts`). A core with no readable source
 * reports `unknown` with its reason — the `arch:AC-05` spirit — and NEVER a
 * fabricated 0%.
 */

/** The reason string D162 recorded for the one remaining unsupported core. */
export const UNSUPPORTED_REASONS: Readonly<Partial<Record<AgentProvider, string>>> = {
  antigravity: 'no local quota source; agy exposes no zero-request usage endpoint',
};

/** A reader that always reports `unknown` with its recorded reason. */
export function unsupportedQuotaReader(core: AgentProvider): QuotaReader {
  const reason = UNSUPPORTED_REASONS[core] ?? 'no readable quota source for this core';
  return {
    core,
    read: async (): Promise<QuotaSnapshot> => ({ core, state: 'unknown', reason }),
  };
}
