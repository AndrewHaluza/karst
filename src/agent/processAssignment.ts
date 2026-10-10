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
  type ProcessKey,
  type ProcessRole,
} from '../manifest/validate/processAssignments.js';
import { resolvePresetSlot, resolveRolePin, type AgentSource } from './agentPresets.js';
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
  /** Which rung of the ladder supplied the core (ticket / pin / preset / default / fallback). Always set by the resolver. */
  source?: AgentSource;
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

  // Rung 2: the PIN (`processes.<key>` with `pinned: true`), "same in all
  // presets". An unpinned row carries no identity (the loader folds legacy
  // rows into presets), so only a pin is read here.
  const pin = resolveRolePin(manifest, key as ProcessKey);

  // Rung 3: the preset slot for THIS role's capability, read by the ONE
  // resolver. The deprecated `processes.<key>.preset` still outranks the
  // ticket's preset name for one release (§6); blanks normalize away at load.
  const slot =
    key === undefined
      ? undefined
      : resolvePresetSlot(manifest, key, config?.preset ?? ticketOverride.preset);

  // Rung 1 over the rest for the CORE: ticket provider, then pin, slot, the
  // manifest default, with 'claude' as the floor (`resolveProvider`).
  const ticketProvider = ticketOverride.provider ?? null;
  const provider = resolveProvider(
    ticketProvider,
    pin?.provider ?? slot?.provider ?? manifest.agentProvider,
  );

  // Pin and slot are ATOMIC: core+model+effort travel together, so each
  // contributes only while the effective core is its own. A ticket that picks
  // another core drops the WHOLE pin/slot. A live pin also shadows the slot.
  const activePin = pin !== undefined && provider === pin.provider ? pin : undefined;
  const activeSlot =
    activePin === undefined && slot !== undefined && provider === slot.provider ? slot : undefined;
  const layer = activePin ?? activeSlot;

  const source: AgentSource =
    ticketProvider !== null
      ? 'ticket'
      : activePin !== undefined
        ? 'pin'
        : activeSlot !== undefined
          ? 'preset'
          : manifest.agentProvider !== undefined
            ? 'default'
            : 'fallback';

  // Ticket, pin/slot and manifest models are catalog-gated; an author-declared
  // pin model is gated too only when a ticket core made it cross (it never
  // does: activePin requires the same core), so it stays verbatim.
  const compatible = (id: string | null | undefined): string | undefined => {
    const value = typeof id === 'string' && id.trim() !== '' ? id : undefined;
    return value !== undefined && isModelCompatibleWithProvider(provider, value, catalog)
      ? value
      : undefined;
  };
  const model =
    compatible(ticketOverride.model) ??
    (activePin !== undefined ? activePin.model : compatible(activeSlot?.model)) ??
    compatible(manifest.defaultModel);

  // Effort follows the same ladder, and every rung is only carried when the
  // RESOLVED model advertises it — a refused rung falls through.
  let effort: string | undefined;
  for (const candidate of [ticketOverride.effort, layer?.effort, manifest.defaultEffort]) {
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
    source,
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
