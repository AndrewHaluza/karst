import type { SetupItem } from '../../init/status.js';

/**
 * Serializable state for the Getting Started page. A live setup checklist plus a fixed
 * how-to tutorial. Plain values so it crosses the postMessage boundary.
 */

export interface TutorialStep {
  id: string;
  label: string;
  description: string;
  /** Which jump button to render, or null for an informational step. */
  action: 'settings' | 'create-ticket' | 'setup-agent' | null;
  /**
   * Whether the action's button is enabled. Absent means enabled. The
   * "Set up with agent" action is gated on the agent-CLI checklist item being
   * green — the agent cannot install its own CLI, so that stays manual.
   */
  enabled?: boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'configure',
    label: 'Set up with agent',
    description: 'The agent discovers your repositories and proposes a manifest; you review and approve.',
    action: 'setup-agent',
  },
  {
    id: 'create',
    label: 'Create your first ticket',
    description: 'Describe the work; Karst fetches or drafts the context brief.',
    action: 'create-ticket',
  },
  {
    id: 'launch',
    label: 'Pick repos + approach and launch the session',
    description: 'Choose which repositories are in scope and how the agent should work, then start.',
    action: null,
  },
  {
    id: 'watch',
    label: 'Watch stage progress on the ticket dashboard',
    description: 'Open a ticket to follow it through scope → impl → uat as the agent runs.',
    action: null,
  },
  {
    id: 'approaches',
    label: 'Optional: install an approach package',
    description: 'Add a curated method (agents, commands, skills) from Settings → Approaches.',
    action: 'settings',
  },
];

export interface GettingStartedState {
  checklist: SetupItem[];
  tutorial: readonly TutorialStep[];
}

/**
 * The setup agent can only run once its CLI is installed. Every dependency that
 * `enables: 'sessions'` (the configured agent's CLI) must be green; the manifest
 * item deliberately does NOT gate it, because creating the manifest is exactly
 * what the setup agent does. With no session-enabling item (never, in practice)
 * the action stays disabled rather than offering a button that cannot work.
 */
export function agentCliReady(checklist: readonly SetupItem[]): boolean {
  const agentItems = checklist.filter((item) => item.enables === 'sessions');
  return agentItems.length > 0 && agentItems.every((item) => item.done);
}

export function buildGettingStartedState(checklist: SetupItem[]): GettingStartedState {
  const ready = agentCliReady(checklist);
  const tutorial = TUTORIAL_STEPS.map((step) =>
    step.action === 'setup-agent' ? { ...step, enabled: ready } : step,
  );
  return { checklist, tutorial };
}
