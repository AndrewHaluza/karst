import type { SetupItem } from '../../init/status.js';

/**
 * Serializable state for the welcome page. A live setup checklist plus a fixed
 * how-to tutorial. Plain values so it crosses the postMessage boundary.
 */

export interface TutorialStep {
  id: string;
  label: string;
  description: string;
  /** Which jump button to render, or null for an informational step. */
  action: 'settings' | 'create-ticket' | null;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'configure',
    label: 'Configure repositories & agent provider',
    description: 'Open Settings to point each repository at its path and pick your agent CLI.',
    action: 'settings',
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

export interface WelcomeState {
  checklist: SetupItem[];
  tutorial: readonly TutorialStep[];
}

export function buildWelcomeState(checklist: SetupItem[]): WelcomeState {
  return { checklist, tutorial: TUTORIAL_STEPS };
}
