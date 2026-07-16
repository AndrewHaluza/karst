import { renderDependencyFault, type DependencyFault } from '../runtime/deps.js';

/**
 * What the status bar should say about unusable dependencies — pure, so the
 * decision is testable and the vscode binding stays a thin wrapper (see the
 * host-agnostic invariant).
 *
 * The status bar exists because the startup toast is dismissible and gone in
 * seconds, while a tool that is missing (or signed out) stays that way until the
 * user fixes it. Null means show nothing: a permanent "all good" badge would be
 * noise on the one surface the user can't dismiss.
 */
export interface DepsIndicator {
  /** Status bar label (supports `$(icon)` syntax). */
  text: string;
  /** Hover text: the full guidance for every faulted tool. */
  tooltip: string;
}

/** How a single fault reads in the bar — enough to act on without clicking. */
function summarize(fault: DependencyFault): string {
  return fault.state === 'missing'
    ? `${fault.dep.label} missing`
    : `${fault.dep.label} not signed in`;
}

export function buildDepsIndicator(faults: readonly DependencyFault[]): DepsIndicator | null {
  const first = faults[0];
  if (!first) return null;

  // One fault gets named outright — "the GitHub CLI not signed in" is readable at
  // a glance, where a bare count forces a click to learn anything at all.
  const text =
    faults.length === 1
      ? `$(warning) Karst: ${summarize(first)}`
      : `$(warning) Karst: ${faults.length} tools need attention`;

  const tooltip = faults
    .map((f) => renderDependencyFault(f.dep, f.state))
    .filter((m): m is string => m !== null)
    .join('\n\n');

  return { text, tooltip };
}
