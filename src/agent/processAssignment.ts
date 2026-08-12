/**
 * Resolve the identity SNAPSHOT for one inside AI process (Task 7): which
 * agent name / provider / model the process should open its `process_runs`
 * row with. A pure function of the manifest + catalog (plus an optional
 * per-ticket override), so the snapshot is written at launch and later
 * Settings edits never touch an already-stored run — that immutability is the
 * point of snapshotting (§ processRuns.ts).
 *
 * Returns `null` when the role's `processes.<key>.enabled` is `false`: a
 * disabled process is configured ABSENCE, not a resolution — no snapshot
 * exists for it, so the execution boundary never creates or instruments an
 * adapter and never opens a process run for it (Finding 2). The check
 * short-circuits BEFORE provider/model resolution.
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
 *   instructions: config.instructions (verbatim — author-declared; absent →
 *              the built-in prompt; no ticket/manifest fallback exists)
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
import type { AgentAdapter } from './adapter.js';

/** The identity snapshot a `process_runs` row is opened with. */
export interface ProcessAssignmentSnapshot {
  agentName?: string;
  provider: AgentProvider;
  model?: string;
  /**
   * The settings agent-pool profile this process is assigned to run as
   * (`processes.<key>.agent`), carried VERBATIM alongside `agentName`. The
   * host resolves the profile's BODY (its custom prompt) into `instructions`
   * at the execution boundary (`processFor`); this field is what lets it know
   * WHICH profile to resolve — `agentName` alone is a display label and can be
   * overridden by `config.agentName`.
   */
  agent?: string;
  /**
   * The prompt instructions the process's headless call is run with: an
   * author-declared `processes.<key>.instructions`, or — when that is absent —
   * the resolved body of the assigned profile (`agent`). Absent entirely → the
   * process's built-in prompt. Snapshotted like the identity fields: a
   * Settings edit mid-run must not rewrite the prompt a live run is reading.
   */
  instructions?: string;
}

/**
 * One EXECUTABLE inside process: the resolved assignment snapshot plus the
 * already-instrumented adapter that runs it. Produced once at each execution
 * boundary (`processFor` in the extension host) and consumed by the driver, the
 * stage runners and Ship; the driver resolves each process exactly once per
 * run, because the host builds a fresh instrumented adapter per call. NULL is
 * the configured ABSENCE (`enabled: false`) — a disabled process is never
 * created, never instrumented and never opens a process run.
 */
export interface DriveProcessBundle {
  assignment: ProcessAssignmentSnapshot;
  adapter: AgentAdapter;
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
  'ticket-analysis': 'Ticket Analysis Agent',
};

/**
 * Resolve the effective identity for `role`: explicit `processes:` config,
 * then the ticket override, then the manifest defaults, then 'claude' — with
 * the model run through the provider-compatibility check at every
 * non-explicit layer. Returns `null` when the role's process config sets
 * `enabled: false` — the disabled role is absent, not resolved.
 */
export function resolveProcessAssignment(
  manifest: Manifest,
  role: ProcessRole,
  ticketOverride: ProcessTicketOverride = {},
  catalog: ModelCatalog = bundledModelCatalog(),
): ProcessAssignmentSnapshot | null {
  const key = PROCESS_KEY_BY_ROLE[role];
  const config = key === undefined ? undefined : manifest.processes?.[key];
  // Finding 2: a disabled process is configured ABSENCE — short-circuit before
  // any provider/model resolution, so the execution boundary offers no
  // adapter for the role and opens no process run.
  if (config?.enabled === false) return null;

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

  return {
    agentName,
    provider,
    model,
    // The profile REFERENCE rides the snapshot so the host's execution
    // boundary can resolve its body as the process's instructions. Carried
    // separately from `agentName`: `config.agentName` overrides the display
    // label without changing which profile drives the prompt.
    ...(config?.agent === undefined ? {} : { agent: config.agent }),
    ...(config?.instructions === undefined ? {} : { instructions: config.instructions }),
  };
}
