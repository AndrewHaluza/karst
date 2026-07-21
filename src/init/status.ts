import type { AgentProvider } from '../manifest/types.js';
import {
  dependencyRegistry,
  dependencyState,
  renderDependencyFault,
  type DependencyProbe,
  type DependencyState,
  type ReadinessProbe,
  type RequiredDependency,
} from '../runtime/deps.js';

/**
 * Pure setup-status model for the welcome page. No vscode, no fs — the PATH probe
 * is injected, so this is directly unit-testable. The checklist is the dependency
 * registry: the manifest item, then one item per declared tool. Adding a
 * dependency never needs an edit here.
 */

export interface SetupItem {
  /** 'manifest', or the dependency's binary name. */
  id: string;
  label: string;
  done: boolean;
  /** Actionable guidance shown under an undone item (or the auth note). */
  detail: string | null;
}

export interface SetupStatusInput {
  manifestExists: boolean;
  provider: AgentProvider;
  /** Reads live PATH truth. Injected so the host owns the side effect. */
  probe: DependencyProbe;
  /** Runs a tool's readiness check (real: `gh auth status`). */
  ready: ReadinessProbe;
}

/** Karst can verify the CLI is installed, not authenticated — remind the user. */
export const AGENT_AUTH_REMINDER =
  'Karst can only check the CLI is installed, not logged in — run its login command once before starting a session.';

/**
 * The agent CLI is the one item with a note that outlives its own check: it
 * declares no readiness probe, so karst cannot see whether the user is logged in
 * and says so either way. Every other tool answers for itself.
 */
function detailFor(dep: RequiredDependency, state: DependencyState, isAgent: boolean): string | null {
  const fault = renderDependencyFault(dep, state);
  if (isAgent) return fault ? `${dep.install}\n\n${AGENT_AUTH_REMINDER}` : AGENT_AUTH_REMINDER;
  // A missing tool's row sits under a label that already said it isn't installed;
  // repeating the sentence adds nothing, so the row shows the install step alone.
  return state === 'missing' ? dep.install : fault;
}

export function buildSetupStatus(input: SetupStatusInput): SetupItem[] {
  const registry = dependencyRegistry(input.provider);

  const deps = registry.map((dep): SetupItem => {
    // Probing the item's OWN binary is what keeps the checklist honest. It used
    // to take a precomputed missing set, so a dependency the caller forgot to
    // probe reported itself installed. Installed-but-unusable is a third answer:
    // a logged-out gh fails ship exactly like an absent one.
    const state = dependencyState(dep, input.probe, input.ready);
    return {
      id: dep.binary,
      // Labels are used verbatim, never case-adjusted: 'npm' is lowercase by its
      // own convention, and "Npm is installed" is a row about a product that has
      // no such name.
      label: `${dep.label} is installed`,
      done: state === 'ok',
      detail: detailFor(dep, state, dep.enables === 'sessions'),
    };
  });

  return [
    {
      id: 'manifest',
      label: 'Create your karst.yml manifest',
      done: input.manifestExists,
      detail: input.manifestExists ? null : 'Karst needs a manifest describing your repositories.',
    },
    ...deps,
  ];
}
