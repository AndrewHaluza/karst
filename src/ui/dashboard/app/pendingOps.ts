/**
 * The operations the stage rail, the header and the Pull requests panel start together, held as ONE React-side
 * store so a second click can never open a second dialog:
 *
 *  - ship: the header's Confirm ship and the rail's Ship button share one in-flight request. Its wire message
 *    carries no request id and the host answers with a state push, so it settles from the push (the ticket left
 *    ship: success; ship itself failed: failure; still running: held), and "shipped" flashes for a moment.
 *  - merge, per repo: the PR panel's Merge and the rail's Merge share them. Same lifetime: every outstanding
 *    request settles on the next settling push, `true` only for a repo that came back merged and unknown
 *    otherwise (a cancelled confirmation is not a failure).
 *
 * Only a settling push (`settlesActions !== false`) is an answer: live clocks and store news are not. Nothing
 * persists: an id restored from a reload would claim an operation nobody is running. The begin methods flush
 * synchronously (the control must read pending before the host's dialog opens).
 */
import { flushSync } from 'react-dom';
import type { HostMessage } from '../messages.js';

/** How long "shipped" stays up after the ticket leaves ship. */
export const SHIPPED_FLASH_MS = 2400;

export interface OpsSnapshot {
  readonly shipping: boolean;
  /** The brief post-success flash. */
  readonly shipped: boolean;
  /** Repos whose merge is in flight. */
  readonly merging: ReadonlySet<string>;
}

const IDLE: OpsSnapshot = { shipping: false, shipped: false, merging: new Set() };

/** The design-system runtime's terminal result for one request (ok: true, false, or null for unknown). */
const runtime = (): { karstSettle(requestId: string, ok: boolean | null, message?: string): void } =>
  globalThis as unknown as { karstSettle(requestId: string, ok: boolean | null, message?: string): void };

export class PendingOps {
  private snapshot: OpsSnapshot = IDLE;
  private shipId: string | null = null;
  private readonly mergeIds = new Map<string, string>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): OpsSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A ship started (from the header or the rail): in flight until the host's push answers. */
  beginShip(requestId: string): void {
    this.clearFlash();
    this.shipId = requestId;
    flushSync(() => this.set({ shipping: true, shipped: false }));
  }

  /** A merge started for `repo` (from the PR panel or the rail). */
  beginMerge(repo: string, requestId: string): void {
    this.mergeIds.set(repo, requestId);
    flushSync(() => this.set({ merging: new Set(this.snapshot.merging).add(repo) }));
  }

  /** Every host message; only a settling `state` push answers anything. */
  receive(message: HostMessage): void {
    if (message.type !== 'state' || message.settlesActions === false) return;
    const state = message.state;
    this.settleShip(state);
    this.settleMerges(state);
  }

  dispose(): void {
    this.clearFlash();
    this.listeners.clear();
  }

  private settleShip(state: Extract<HostMessage, { type: 'state' }>['state']): void {
    const requestId = this.shipId;
    if (requestId === null) return;
    const atShip = state.stageCurrent === 'ship';
    const failed = atShip && state.currentStage?.status === 'failed';
    // Still at ship and running: hold the request across this push so a later one can settle it.
    if (!failed && atShip) return;
    this.shipId = null;
    if (failed) {
      runtime().karstSettle(requestId, false);
      this.set({ shipping: false });
      return;
    }
    runtime().karstSettle(requestId, true);
    this.set({ shipping: false, shipped: true });
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.set({ shipped: false });
    }, SHIPPED_FLASH_MS);
  }

  private settleMerges(state: Extract<HostMessage, { type: 'state' }>['state']): void {
    if (this.mergeIds.size === 0) return;
    const prByRepo = new Map((state.prs ?? []).map((p) => [p.repo, p]));
    for (const [repo, requestId] of this.mergeIds) {
      const merged = prByRepo.get(repo)?.status === 'merged';
      runtime().karstSettle(requestId, merged ? true : null, merged ? 'Merged.' : undefined);
    }
    this.mergeIds.clear();
    this.set({ merging: new Set() });
  }

  private clearFlash(): void {
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = null;
  }

  private set(patch: Partial<OpsSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.shipping === this.snapshot.shipping && next.shipped === this.snapshot.shipped && next.merging === this.snapshot.merging) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
