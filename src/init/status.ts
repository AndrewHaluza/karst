import type { AgentProvider } from '../manifest/types.js';
import { GIT_DEPENDENCY, agentDependency, type RequiredDependency } from '../runtime/deps.js';

/**
 * Pure setup-status model for the welcome page. No vscode, no fs — every input
 * is injected so this is directly unit-testable. The host reads live disk/PATH
 * truth and passes it in; this composes the 3-item checklist.
 */

export interface SetupItem {
  id: 'manifest' | 'git' | 'agent-cli';
  label: string;
  done: boolean;
  /** Actionable guidance shown under an undone item (or the auth note). */
  detail: string | null;
}

export interface SetupStatusInput {
  manifestExists: boolean;
  missingDeps: readonly RequiredDependency[];
  provider: AgentProvider;
}

/** Karst can verify the CLI is installed, not authenticated — remind the user. */
export const AGENT_AUTH_REMINDER =
  'Karst can only check the CLI is installed, not logged in — run its login command once before starting a session.';

export function buildSetupStatus(input: SetupStatusInput): SetupItem[] {
  const missing = new Set(input.missingDeps.map((d) => d.binary));
  const agentDep = agentDependency(input.provider);
  const gitDone = !missing.has(GIT_DEPENDENCY.binary);
  const agentDone = !missing.has(agentDep.binary);

  return [
    {
      id: 'manifest',
      label: 'Create your karst.yml manifest',
      done: input.manifestExists,
      detail: input.manifestExists ? null : 'Karst needs a manifest describing your services.',
    },
    {
      id: 'git',
      label: 'Git is installed',
      done: gitDone,
      detail: gitDone ? null : GIT_DEPENDENCY.install,
    },
    {
      id: 'agent-cli',
      label: `${agentDep.label} is installed`,
      done: agentDone,
      // The auth reminder is always present; install guidance is prepended when missing.
      detail: agentDone ? AGENT_AUTH_REMINDER : `${agentDep.install}\n\n${AGENT_AUTH_REMINDER}`,
    },
  ];
}
