import type { SetupItem } from '../../init/status.js';
import type { AgentSetupView } from '../../setup/checklist/panelView.js';

/**
 * Serializable state for the Getting Started page. A live setup checklist plus a fixed
 * how-to tutorial. Plain values so it crosses the postMessage boundary.
 *
 * Every count and every sentence is built HERE, on the host (`@arch:NTF-07`): the
 * webview has no store access, so it renders the words it is given and never
 * counts a list itself.
 */

export interface TutorialStep {
  id: string;
  label: string;
  description: string;
  /** Which jump button to render, or null for an informational step. */
  action: 'settings' | 'create-ticket' | 'setup-agent' | null;
  /**
   * Whether this step's setup work is already done. Only the steps that track
   * real progress (the manifest, the first ticket) set it; absent means open.
   */
  done?: boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'configure',
    label: 'Set up with agent',
    // The manifest actions live in the manifest row of the setup checklist (Q5),
    // so this step points there instead of offering a second first step.
    description: 'Use the manifest row in the setup checklist above.',
    action: null,
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
    description: 'Choose the repositories and the approach, then start the session',
    action: null,
  },
  {
    id: 'watch',
    label: 'Watch stage progress on the ticket dashboard',
    description: 'Follow the ticket through its stages on the ticket dashboard.',
    action: null,
  },
  {
    id: 'approaches',
    label: 'Optional: install an approach package',
    description: 'Add a curated method (agents, commands, skills) from Settings → Approaches.',
    action: 'settings',
  },
];

/** The two ways to create the manifest, as message names the webview already posts. */
export type ManifestActionId = 'setup-agent' | 'create-manifest';

/** Which manifest-row action is primary, and which is secondary (its inverse). */
export interface ManifestActions {
  primary: ManifestActionId;
  secondary: ManifestActionId;
}

export interface GettingStartedState {
  checklist: SetupItem[];
  /** The 9-item first-setup list, computed by the host in a child process. Absent in old fixtures. */
  agentSetup?: AgentSetupView;
  tutorial: readonly TutorialStep[];
  /** "{done} of {total} done" beside the "Setup checklist" heading. */
  progressText: string;
  /** The page lede, which follows the setup state and the ticket count. */
  lede: string;
  /** Which manifest-row action is primary, ordered by the agent CLI's readiness. */
  manifestActions: ManifestActions;
}

/**
 * The setup agent can only run once its CLI is installed. Every dependency that
 * `enables: 'sessions'` (the configured agent's CLI) must be green; the manifest
 * item deliberately does NOT gate it, because creating the manifest is exactly
 * what the setup agent does. With no session-enabling item (never, in practice)
 * the CLI counts as not ready rather than offering a button that cannot work.
 */
export function agentCliReady(checklist: readonly SetupItem[]): boolean {
  const agentItems = checklist.filter((item) => item.enables === 'sessions');
  return agentItems.length > 0 && agentItems.every((item) => item.done);
}

/** "{done} of {total} done" — the progress line beside the checklist heading. */
export function progressTextFor(checklist: readonly SetupItem[]): string {
  return `${checklist.filter((item) => item.done).length} of ${checklist.length} done`;
}

/**
 * The lede follows real progress: unfinished setup first, then whether this
 * workspace already holds a ticket (`@arch:NTF-07` keeps the sentence on the host).
 */
function ledeFor(checklist: readonly SetupItem[], ticketCount: number): string {
  if (!checklist.every((item) => item.done)) return 'Finish the setup below.';
  return ticketCount > 0 ? 'Setup is complete.' : 'Setup is complete. Create a ticket to start.';
}

export function buildGettingStartedState(
  checklist: SetupItem[],
  progress: { ticketCount: number },
  agentSetup?: AgentSetupView,
): GettingStartedState {
  const ready = agentCliReady(checklist);
  const manifestDone = checklist.find((item) => item.id === 'manifest')?.done === true;
  const returning = progress.ticketCount > 0;
  const tutorial = TUTORIAL_STEPS.map((step): TutorialStep => {
    if (step.id === 'configure') return { ...step, done: manifestDone };
    if (step.id === 'create') {
      return returning
        ? {
            ...step,
            label: 'Create a ticket',
            description: 'Describe the work. Karst fetches or drafts the context brief.',
            done: true,
          }
        : { ...step, done: false };
    }
    return step;
  });
  const state: GettingStartedState = {
    checklist,
    tutorial,
    progressText: progressTextFor(checklist),
    lede: ledeFor(checklist, progress.ticketCount),
    manifestActions: ready
      ? { primary: 'setup-agent', secondary: 'create-manifest' }
      : { primary: 'create-manifest', secondary: 'setup-agent' },
  };
  return agentSetup === undefined ? state : { ...state, agentSetup };
}
