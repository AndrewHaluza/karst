import { renderDependencyFault, type Capability, type DependencyFault } from '../../runtime/deps.js';
import type { AgentProvider } from '../../manifest/types.js';
import type { DependencyProbeService } from './dependencyProbes.js';

export interface CapabilityGuardDeps {
  readonly probes: Pick<DependencyProbeService, 'capabilityFaults' | 'isCapabilityKnownBlocked'>;
  /** The agent provider that decides the registry for this ticket (or the manifest default). */
  readonly providerFor: (ticketId?: number) => AgentProvider;
  /** Repaint the dependency status bar from the faults of a refusal. */
  readonly onBlocked: () => void;
  readonly warn: (message: string) => void;
  /** Show the refusal text. Resolves true when the user asks for the setup checklist. */
  readonly showError: (text: string) => Promise<boolean>;
  readonly openChecklist: () => void;
}

/**
 * Resolves true when the capability's tools are usable; otherwise tells the user why not.
 * `known` is a sync, silent view for a seam that cannot wait: false only when an
 * earlier probe settled with a fault; a cold or stale cache is not a refusal. It starts the probe it lacks.
 */
export interface AsyncCapabilityGuard {
  (capability: Capability, ticketId?: number, silent?: boolean): Promise<boolean>;
  known(capability: Capability, ticketId?: number): boolean;
}

/** The refusal text for a set of faults. */
export function describeFaults(faults: readonly DependencyFault[]): string {
  return faults
    .map((f) => renderDependencyFault(f.dep, f.state, f.timedOut === true))
    .filter((m): m is string => m !== null)
    .join(' ');
}

/** Resolves true when the capability's tools are usable for an explicit provider. */
export type AsyncProviderGuard = (
  capability: Capability,
  provider: AgentProvider,
  silent?: boolean,
) => Promise<boolean>;

/**
 * Point-of-use guard for an explicit provider. A caller awaits it and stops its
 * action on `false`: a failed or timed-out probe still blocks. The probe runs
 * off the event loop and its outcome is cached (see `createDependencyProbes`).
 */
export function createProviderGuard(
  deps: Omit<CapabilityGuardDeps, 'providerFor'>,
): AsyncProviderGuard {
  return async (capability, provider, silent = false) => {
    const faults = await deps.probes.capabilityFaults(capability, provider);
    if (faults.length === 0) return true;
    deps.onBlocked();
    for (const f of faults) {
      deps.warn(`blocked: '${f.dep.binary}' is ${f.timedOut ? 'not answering' : f.state}`);
    }
    if (!silent) {
      void deps.showError(describeFaults(faults)).then((open) => {
        if (open) deps.openChecklist();
      });
    }
    return false;
  };
}

/** The guard for a ticket: the provider comes from the ticket, else the manifest default. */
export function createCapabilityGuard(deps: CapabilityGuardDeps): AsyncCapabilityGuard {
  const guard = createProviderGuard(deps);
  const guardTicket = (capability: Capability, ticketId?: number, silent?: boolean): Promise<boolean> =>
    guard(capability, deps.providerFor(ticketId), silent);
  return Object.assign(guardTicket, {
    known: (capability: Capability, ticketId?: number): boolean =>
      !deps.probes.isCapabilityKnownBlocked(capability, deps.providerFor(ticketId)),
  });
}
