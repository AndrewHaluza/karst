import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import type { AutostartCaps } from '../workflow/subtaskAutostart.js';
import { autopilotSweep, ciOutcome } from './ops/autopilotWiring.js';
import { resolveConflictRound, type ResolveConflictInput } from './ops/conflictResolveOps.js';
import type { CiActionsInput } from './ops/ciActionsWiring.js';

export interface AutopilotBindingDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly manifest: () => Manifest | undefined;
  readonly caps: () => AutostartCaps;
  readonly debug: (message: string) => void;
  readonly changed: () => void;
  readonly intervalMs: number;
  /** This window holds a live session for the ticket. */
  readonly isLive: (ticketId: number) => boolean;
  readonly roundInput: (ticketId: number, repo: string) => ResolveConflictInput;
  readonly ciInput: (ticketId: number) => CiActionsInput;
}

/**
 * Start the autopilot sweep. Ownership follows the sandbox rule (AC-37): this window controls a
 * ticket when it holds the session, or when no window runs one. "Session running" uses the same data.
 */
export function startAutopilot(d: AutopilotBindingDeps): { dispose(): void } {
  const running = (id: number): boolean => d.isLive(id) || getTicket(d.store, id).agentState === 'running';
  const timer = setInterval(() => void autopilotSweep({
    store: d.store, projectId: d.projectId, manifest: d.manifest, caps: d.caps, debug: d.debug, changed: d.changed,
    seamsFor: (id) => ({
      controls: () => d.isLive(id) || getTicket(d.store, id).agentState !== 'running',
      sessionRunning: () => running(id),
      resolveRound: (repo) => resolveConflictRound(d.roundInput(id, repo)),
      sendCi: () => ciOutcome(d.ciInput(id)),
    }),
  }), d.intervalMs);
  return { dispose: () => clearInterval(timer) };
}
