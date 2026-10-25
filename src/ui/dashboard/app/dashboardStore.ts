/**
 * The dashboard app's client-side store: the host's latest `state` snapshot plus the
 * supplemental facts that ride their own host messages (live Git totals).
 *
 * It is the single place host messages are folded into React-visible state, so a panel
 * never subscribes to the bridge itself (the page buffers messages for the FIRST
 * subscriber only; the provider must be that subscriber, whatever order effects run in).
 */
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import type { WorktreeStats } from '../worktreeStats.js';

export interface DashboardSnapshot {
  readonly state: DashboardState | null;
  /** Live additions/deletions by worktree repo: supplemental, cleared whenever a newer snapshot arrives. */
  readonly worktreeStats: Readonly<Record<string, WorktreeStats>>;
}

const NO_STATS: DashboardSnapshot['worktreeStats'] = Object.freeze({});

export class DashboardStore {
  private snapshot: DashboardSnapshot;
  private readonly subscribers = new Set<() => void>();
  private readonly messageListeners = new Set<(message: HostMessage) => void>();

  constructor(state: DashboardState | null) {
    this.snapshot = { state, worktreeStats: NO_STATS };
  }

  readonly getSnapshot = (): DashboardSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  };

  /** Every host message, after the snapshot has absorbed it (e.g. an `action-result` a panel waits on). */
  readonly onMessage = (listener: (message: HostMessage) => void): (() => void) => {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  };

  receive(message: HostMessage): void {
    if (message.type === 'state') {
      // The matching totals message follows a full snapshot; until then show none rather than
      // numbers for an older working tree. A live repaint or a store-only push is not followed
      // by one, and the worktrees did not change, so the current totals stay.
      const keep = message.live === true || message.supplemental === false;
      this.snapshot = { state: message.state, worktreeStats: keep ? this.snapshot.worktreeStats : NO_STATS };
      this.notify();
    } else if (message.type === 'worktree-stats') {
      this.snapshot = {
        ...this.snapshot,
        worktreeStats: Object.fromEntries(message.stats.map((stats) => [stats.repo, stats])),
      };
      this.notify();
    }
    for (const listener of [...this.messageListeners]) listener(message);
  }

  private notify(): void {
    for (const listener of [...this.subscribers]) listener();
  }
}
