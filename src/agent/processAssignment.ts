/**
 * Resolve the identity SNAPSHOT for one inside AI process (Task 7): which
 * agent name / provider / model the process should open its `process_runs`
 * row with. A pure function of the manifest + catalog (plus an optional
 * per-ticket override), so the snapshot is written at launch and later
 * Settings edits never touch an already-stored run — that immutability is the
 * point of snapshotting (§ processRuns.ts).
 *
 * Precedence per field (most specific wins, matching `resolveProvider` /
 * `resolveModelForProvider`'s launch conventions):
 *   agentName: config.agentName → config.agent (the referenced profile's
 *              name) → ticket override → role default
 *   provider:  config.provider → ticket override → manifest.agentProvider
 *              → 'claude'
 *   model:     config.model (verbatim — author-declared) → ticket model →
 *              manifest.defaultModel, both through the provider-compatibility
 *              check (a known model of another provider is dropped, never
 *              launched wrong)
 */

import type { AgentProvider, Manifest } from '../manifest/types.js';
import {
  PROCESS_KEY_BY_ROLE,
  type ProcessRole,
} from '../manifest/validate/processAssignments.js';
import { resolveProvider } from './provider.js';
import { resolveModelForProvider } from './models.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentIdentity.js';

/** The identity snapshot a `process_runs` row is opened with. */
export interface ProcessAssignmentSnapshot {
  agentName?: string;
  provider: AgentProvider;
  model?: string;
}

/** Per-ticket override for one process role (ticket fields, all optional). */
export interface ProcessTicketOverride {
  provider?: AgentProvider | null;
  model?: string | null;
  agentName?: string | null;
}

/**
 * Approved display names for the inside AI roles when nothing is configured.
 * `pr-description` is deliberately absent: its default is the ticket-resolved
 * PR-description ADAPTER (the provider's own label), never a fixed name.
 */
export const DEFAULT_PROCESS_AGENT_NAMES: Readonly<
  Record<Exclude<ProcessRole, 'pr-description'>, string>
> = {
  'uat-tester': 'UAT Agent',
  'uat-fix': 'UAT Fix Agent',
  review: 'Review Agent',
  'review-fix': 'Review Fix Agent',
};

/**
 * Resolve the effective identity for `role`: explicit `processes:` config,
 * then the ticket override, then the manifest defaults, then 'claude' — with
 * the model run through the provider-compatibility check at every
 * non-explicit layer.
 */
export function resolveProcessAssignment(
  manifest: Manifest,
  role: ProcessRole,
  ticketOverride: ProcessTicketOverride = {},
  catalog: ModelCatalog = bundledModelCatalog(),
): ProcessAssignmentSnapshot {
  const key = PROCESS_KEY_BY_ROLE[role];
  const config = key === undefined ? undefined : manifest.processes?.[key];

  const provider =
    config?.provider ?? resolveProvider(ticketOverride.provider ?? null, manifest.agentProvider);

  const model =
    config?.model ??
    resolveModelForProvider(provider, ticketOverride.model ?? null, manifest.defaultModel, catalog);

  const agentName =
    config?.agentName ??
    config?.agent ??
    ticketOverride.agentName ??
    (role === 'pr-description'
      ? AGENT_PROVIDER_LABELS[provider]
      : DEFAULT_PROCESS_AGENT_NAMES[role]);

  return { agentName, provider, model };
}
