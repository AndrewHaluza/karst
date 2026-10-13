import type { AgentProvider } from '../../manifest/types.js';
import type { QuotaReader, QuotaSnapshot } from './types.js';

/**
 * The `unknown` readers (`arch:AC-29`).
 *
 * D162 probed every core for a zero-request quota source. Antigravity and
 * OpenCode have none: their subscription windows live in a provider backend
 * (Google Cloud Quotas / the OpenCode Go Console) with no local telemetry file
 * and no public zero-spend usage endpoint, so a probe would cost a model
 * request. A core with no readable source reports `unknown` with its reason —
 * the `arch:AC-05` spirit — and NEVER a fabricated 0%.
 */

/** The reason strings D162 recorded, one per unsupported core. */
export const UNSUPPORTED_REASONS: Readonly<Partial<Record<AgentProvider, string>>> = {
  antigravity: 'no local quota source; agy exposes no zero-request usage endpoint',
  opencode: 'no local quota source; OpenCode Go has no public usage API',
  opencode2: 'no local quota source; OpenCode Go has no public usage API',
};

/** A reader that always reports `unknown` with its recorded reason. */
export function unsupportedQuotaReader(core: AgentProvider): QuotaReader {
  const reason = UNSUPPORTED_REASONS[core] ?? 'no readable quota source for this core';
  return {
    core,
    read: (): QuotaSnapshot => ({ core, state: 'unknown', reason }),
  };
}
