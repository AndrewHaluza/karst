import type { AgentProvider } from '../manifest/types.js';
import {
  dependencyRegistry,
  dependencyState,
  renderDependencyFault,
  type Capability,
  type DependencyFault,
  type DependencyProbe,
  type DependencyState,
  type OutputProbe,
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
  /**
   * The dependency's `enables` category (`'sessions'` for an agent CLI). Absent
   * on the manifest item. The Getting Started page gates its "Set up with
   * agent" action on the session-enabling item(s) being green.
   */
  enables?: Capability;
}

export interface SetupStatusInput {
  manifestExists: boolean;
  provider: AgentProvider;
  /** Reads live PATH truth. Injected so the host owns the side effect. */
  probe: DependencyProbe;
  /** Runs a tool's readiness check (real: `gh auth status`). */
  ready: ReadinessProbe;
  /** Reads a readiness command's output, for an output-validating dependency. */
  readOutput?: OutputProbe;
}

/** Karst can verify the CLI is installed, not authenticated — remind the user. */
export const AGENT_AUTH_REMINDER =
  'Karst can only check the CLI is installed, not logged in — run its login command once before starting a session.';

/**
 * The agent CLI is the one item with a note that outlives its own check: it
 * declares no readiness probe, so karst cannot see whether the user is logged in
 * and says so either way. Every other tool answers for itself.
 */
function detailFor(
  dep: RequiredDependency,
  state: DependencyState,
  isAgent: boolean,
  timedOut = false,
): string | null {
  const fault = renderDependencyFault(dep, state, timedOut);
  if (isAgent && timedOut) return fault;
  if (isAgent) return fault ? `${dep.install}\n\n${AGENT_AUTH_REMINDER}` : AGENT_AUTH_REMINDER;
  // A missing tool's row sits under a label that already said it isn't installed;
  // repeating the sentence adds nothing, so the row shows the install step alone.
  return state === 'missing' ? dep.install : fault;
}

export function buildSetupStatus(input: SetupStatusInput): SetupItem[] {
  // Probing the item's OWN binary is what keeps the checklist honest. It used
  // to take a precomputed missing set, so a dependency the caller forgot to
  // probe reported itself installed. Installed-but-unusable is a third answer:
  // a logged-out gh fails ship exactly like an absent one.
  return buildSetupItems(input, (dep) =>
    dependencyState(dep, input.probe, input.ready, input.readOutput),
  );
}

/** Input for a checklist built from faults an async probe already found: one probe pass, no second one. */
export interface SetupStatusFromFaultsInput {
  manifestExists: boolean;
  provider: AgentProvider;
  /** Every fault of the registry for the provider. A dependency with no fault is ready. */
  faults: readonly DependencyFault[];
}

export function buildSetupStatusFromFaults(input: SetupStatusFromFaultsInput): SetupItem[] {
  return buildSetupItems(
    input,
    (dep) => input.faults.find((f) => f.dep.binary === dep.binary)?.state ?? 'ok',
    (dep) => input.faults.find((f) => f.dep.binary === dep.binary)?.timedOut === true,
  );
}

function buildSetupItems(
  input: { manifestExists: boolean; provider: AgentProvider },
  stateOf: (dep: RequiredDependency) => DependencyState,
  timedOut: (dep: RequiredDependency) => boolean = () => false,
): SetupItem[] {
  const registry = dependencyRegistry(input.provider);

  const deps = registry.map((dep): SetupItem => {
    const state = stateOf(dep);
    return {
      id: dep.binary,
      // Labels are used verbatim, never case-adjusted: 'npm' is lowercase by its
      // own convention, and "Npm is installed" is a row about a product that has
      // no such name.
      label: `${dep.label} is installed`,
      done: state === 'ok',
      detail: detailFor(dep, state, dep.enables === 'sessions', timedOut(dep)),
      enables: dep.enables,
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
