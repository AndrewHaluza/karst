import type { Store } from '../../store/db.js';
import type {
  Manifest,
  AgentProvider,
  PresetCapability,
} from '../../manifest/types.js';
import { PRESET_CAPABILITIES } from '../../manifest/types.js';
import { getTicket } from '../../store/tickets.js';
import type { SessionConfiguredInput } from '../../model/inside/agent.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { resolveModelForProvider } from '../../agent/models.js';
import { resolvePresetDefaults, resolvePresetSlot } from '../../agent/agentPresets.js';
import { isRunnable } from '../../manifest/runnable.js';
import type { CapabilityIdentity, DashboardAgentContext } from './stateTypes.js';

/**
 * The graph profile ids: their identity comes from the approach's own profile
 * config, so a preset slot is the ONLY rung a dashboard identity reads for
 * them — `resolvePresetDefaults` would compose a manifest default a graph
 * profile has no notion of.
 */
const GRAPH_CAPABILITIES: ReadonlySet<PresetCapability> = new Set<PresetCapability>([
  'graphExpert',
  'graphWorker',
  'graphFast',
]);

/**
 * The manifest/agent resolution the manager performs on behalf of the state
 * builder. The manager is manifest-free by contract, so every manifest fact
 * arrives through the injected getters these helpers are handed.
 */

/**
 * The runnable services in the ticket's scope, by repository NAME. Non-runnable
 * repositories are absent by construction (isRunnable is the only gate) — a
 * repo with no `service:` block has no process to name.
 */
export function serviceNamesFor(store: Store, manifest: Manifest, ticketId: number): string[] {
  const scoped = new Set(getTicket(store, ticketId)?.selectedRepos ?? []);
  return Object.entries(manifest.repositories)
    .filter(([name, repo]) => scoped.has(name) && isRunnable(repo))
    .map(([name]) => name);
}

/**
 * The manifest repository NAME for a recorded repo value — the runtime
 * tables (`ship_repo_steps`, `prs`, `merge_checks`) key by repo PATH, and
 * the inside rows must say "Karst-extention", never
 * "/Users/nd/Work/projects/karst/". A path the manifest does not know
 * (deleted repo, foreign row) falls back to the raw value.
 */
export function repoNameFor(manifest: Manifest, repo: string): string | undefined {
  for (const [name, def] of Object.entries(manifest.repositories)) {
    if (def.repoPath === repo) return name;
  }
  return undefined;
}

/**
 * The dashboard's agent context, enriched with the EFFECTIVE identity of every
 * `PRESET_CAPABILITIES` capability (§7.6). The manager is manifest-free by
 * contract, so the identities are computed here from the injected manifest
 * getter; without a manifest the state builder falls back to the legacy
 * context defaults.
 *
 * Every capability is computed, never a hand-picked subset: the launch paths
 * resolve all of them, so the dashboard that states them must not stop at the
 * three it happens to label.
 */
export function agentContextFor(
  base: DashboardAgentContext | undefined,
  manifest: Manifest | undefined,
  ticketPreset?: string | null,
  ticketProvider?: AgentProvider | null,
): DashboardAgentContext {
  const ctx = base ?? {};
  if (!manifest) return ctx;

  const opts = {
    ticketPreset: ticketPreset ?? null,
    explicitProvider: ticketProvider ?? null,
  };
  const capabilityIdentity = {} as Record<PresetCapability, CapabilityIdentity | null>;

  for (const capability of PRESET_CAPABILITIES) {
    if (GRAPH_CAPABILITIES.has(capability)) {
      // A graph slot applies as declared — it is the approach's own profile
      // binding, and nothing at ticket level overrides it. Absent slot is
      // Inherit (null): the approach's profile config wins untouched.
      const slot = resolvePresetSlot(manifest, capability, opts.ticketPreset);
      capabilityIdentity[capability] = slot
        ? { provider: slot.provider, model: slot.model ?? null, effort: slot.effort ?? null }
        : null;
      continue;
    }
    // Everything else is the rung-2-over-rung-4 composition every launch path
    // without a process config of its own uses: explicit core → slot →
    // manifest defaults, so it is never null once a manifest exists.
    const defaults = resolvePresetDefaults(manifest, capability, opts);
    capabilityIdentity[capability] = {
      provider: defaults.provider,
      model: defaults.model ?? null,
      effort: defaults.effort ?? null,
    };
  }

  return {
    ...ctx,
    capabilityIdentity,
  };
}

/**
 * The provider/model karst is CONFIGURED to run for one inside process —
 * shown before any recorded segment exists. Never the recorded identity: a
 * process_runs snapshot is what actually ran and outranks this everywhere it
 * exists (model/inside/agent.ts).
 */
export function assignmentFor(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  processId: 'session' | 'tester' | 'review',
): SessionConfiguredInput | null {
  if (!manifest) return null;
  const ticket = getTicket(store, ticketId);
  if (processId === 'session') {
    // The implementation session has no process role: it is the ticket's own
    // agent, resolved by the launch precedence rule with the ticket's preset
    // supplying the manifest-level defaults.
    const defaults = resolvePresetDefaults(manifest, 'implementation', {
      ticketPreset: ticket?.agentPreset,
      explicitProvider: ticket?.agentProvider ?? null,
    });
    const provider = defaults.provider;
    return { provider, model: resolveModelForProvider(provider, ticket?.model ?? null, defaults.model) ?? null };
  }
  const role = processId === 'tester' ? 'uat-tester' : 'review';
  const snapshot = resolveProcessAssignment(manifest, role, {
    provider: ticket?.agentProvider ?? undefined,
    model: ticket?.model ?? undefined,
    preset: ticket?.agentPreset ?? undefined,
  });
  // NULL is configured ABSENCE (`enabled: false`), not "unknown" — the caller
  // renders it as a disabled process, never as a missing lookup.
  return snapshot ? { provider: snapshot.provider, model: snapshot.model ?? null } : null;
}
