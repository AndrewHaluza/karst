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
 * Precedence per field — the §4 ladder, most specific first:
 *   enabled:   `processes.<key>.enabled: false` WINS outright: the role is
 *              configured absence, resolved before any of the rungs below.
 *   provider:  ticket override → preset slot (§4 rung 2) →
 *              processes.<key>.provider → manifest.agentProvider → 'claude'
 *   model:     ticket override → preset slot → processes.<key>.model
 *              (verbatim, but only on the core that config declares — a core
 *              the ticket picked above it never drags it across) →
 *              manifest.defaultModel; the ticket/slot/manifest candidates go
 *              through the provider-compatibility check (a known model of
 *              another provider is dropped, never launched wrong)
 *   effort:    ticket override → preset slot → processes.<key>.effort →
 *              manifest.defaultEffort, every candidate dropped unless the
 *              RESOLVED model advertises the value (the same rule
 *              `resolveEffortForProvider` applies to every launch)
 *   agentName: config.agentName → config.agent (the referenced profile's
 *              name) → ticket override → role default — presets never touch
 *              it: `agentName`/`agent` are the profile prompt, not the identity
 *   instructions: NOT resolved here — the host's execution boundary resolves
 *              the assigned profile's BODY (`agent`) into it. There is no
 *              manifest-declared prompt any more; the profile is the prompt.
 *
 * The preset rung is resolved by the ONE resolver (`resolvePresetSlot`) for
 * THIS role's own capability (`uatTester` for `uat-tester`, …), and applies as
 * a whole slot: core + model + effort travel together, so a preset never hands
 * its model to another core. §6 keeps `processes.<key>.preset` readable for one
 * release — it outranks the ticket's own preset name, exactly as before.
 */

import type { AgentProvider, Manifest } from '../manifest/types.js';
import {
  PROCESS_KEY_BY_ROLE,
  type ProcessRole,
} from '../manifest/validate/processAssignments.js';
import { resolvePresetSlot } from './agentPresets.js';
import { resolveEffortForProvider, isModelCompatibleWithProvider } from './models.js';
import { resolveProvider } from './provider.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentIdentity.js';
import type { AgentAdapter } from './adapter.js';

/** The identity snapshot a `process_runs` row is opened with. */
export interface ProcessAssignmentSnapshot {
  agentName?: string;
  provider: AgentProvider;
  model?: string;
  effort?: string;
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
   * The prompt the process's headless call is run with: the resolved body of
   * the assigned profile (`agent`), filled in by the host's execution boundary
   * (`processFor`) — never by this resolver, which cannot read the filesystem
   * pool. Absent → the process's built-in prompt. Snapshotted like the
   * identity fields: a Settings edit mid-run must not rewrite the prompt a
   * live run is reading.
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
  effort?: string | null;
  agentName?: string | null;
  /** Per-ticket agent-preset name; the process's own `preset` wins over it. */
  preset?: string | null;
}

/**
 * Approved display names for the inside AI roles when nothing is configured.
 * `pr-description` is deliberately absent: its default is the ticket-resolved
 * PR-description ADAPTER (the provider's own label), never a fixed name.
 * `planning` is a display name only — a planning session opens no `process_runs`
 * row, but the shared resolver's snapshot shape still requires it.
 */
export const DEFAULT_PROCESS_AGENT_NAMES: Readonly<
  Record<Exclude<ProcessRole, 'pr-description'>, string>
> = {
  'uat-tester': 'UAT Agent',
  'uat-fix': 'UAT Fix Agent',
  review: 'Review Agent',
  'review-fix': 'Review Fix Agent',
  'ticket-analysis': 'Ticket Analysis Agent',
  planning: 'Planner',
};

/**
 * Resolve the effective identity for `role`: the ticket's own fields, then the
 * preset slot for the role's capability, then the explicit `processes:` config,
 * then the manifest defaults, then 'claude' — with the ticket/slot/manifest
 * model candidates run through the provider-compatibility check at every
 * non-explicit layer. Returns `null` when the role's process config sets
 * `enabled: false` — the disabled role is absent, not resolved, and wins
 * before any rung below it is even read.
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

  // §4 rung 2: the preset slot for THIS role's capability, read by the ONE
  // resolver. The deprecated `processes.<key>.preset` still outranks the
  // ticket's preset name for one release (§6); blanks normalize away at load.
  const slot =
    key === undefined
      ? undefined
      : resolvePresetSlot(manifest, key, config?.preset ?? ticketOverride.preset);

  // Rung 1 over rungs 2–4 for the CORE: the ticket's own provider first, then
  // the slot, then the process config, then the manifest default, with 'claude'
  // as the floor (`resolveProvider`'s convention).
  const provider = resolveProvider(
    ticketOverride.provider ?? null,
    slot?.provider ?? config?.provider ?? manifest.agentProvider,
  );

  // §4 rung 2 is ATOMIC: the slot's core+model+effort travel together, so it
  // contributes only while the effective core is the slot's own. A ticket that
  // explicitly picks another core drops the WHOLE slot — never just its model —
  // and the rungs below (config, then manifest) take over.
  const activeSlot = slot !== undefined && provider === slot.provider ? slot : undefined;

  // The ticket and slot models are catalog-gated; the config model stays
  // VERBATIM — an author-declared model is launched as written, even when the
  // catalog knows it for another core — but only ON THE CORE THAT CONFIG
  // DECLARES. A ticket that picks a different core (rung 1) must not drag it
  // across: "a model never crosses to another core" holds for this rung too.
  // The manifest default is gated last.
  const compatible = (id: string | null | undefined): string | undefined => {
    const value = typeof id === 'string' && id.trim() !== '' ? id : undefined;
    return value !== undefined && isModelCompatibleWithProvider(provider, value, catalog)
      ? value
      : undefined;
  };
  const configModel =
    config?.model === undefined
      ? undefined
      : provider === (config.provider ?? manifest.agentProvider)
        ? config.model
        : compatible(config.model);
  const model =
    compatible(ticketOverride.model) ??
    compatible(activeSlot?.model) ??
    configModel ??
    compatible(manifest.defaultModel);

  // Effort follows the same ladder, and every rung is only carried when the
  // RESOLVED model advertises it — an explicit value for a model with no
  // advertised efforts is a configuration error the settings view reports,
  // never something silently launched (`resolveEffortForProvider`'s rule,
  // applied candidate by candidate so a refused rung falls through instead of
  // ending the resolution).
  let effort: string | undefined;
  for (const candidate of [
    ticketOverride.effort,
    activeSlot?.effort,
    config?.effort,
    manifest.defaultEffort,
  ]) {
    effort = resolveEffortForProvider(provider, candidate ?? null, null, model, catalog);
    if (effort !== undefined) break;
  }

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
    // The resolved effort rides the snapshot only when the resolved model
    // advertises it (`resolveEffortForProvider` refuses the rest); an absent
    // value is left off so the launch keeps the agent CLI's own default.
    ...(effort === undefined ? {} : { effort }),
    // The profile REFERENCE rides the snapshot so the host's execution
    // boundary can resolve its body as the process's instructions. Carried
    // separately from `agentName`: `config.agentName` overrides the display
    // label without changing which profile drives the prompt.
    ...(config?.agent === undefined ? {} : { agent: config.agent }),
  };
}
