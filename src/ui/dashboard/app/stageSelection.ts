/**
 * Which stage the Inside block (and the rail's selection ring) shows. Selection is LOCAL: it is not in
 * `DashboardState` and is never posted back, because pushes land on every driver tick and anything routed through
 * the host would snap the panel back mid-run. `null` means "no explicit selection": the strip follows the
 * ticket (presented stage, else the current one, else scope).
 *
 * The rail and the Inside block are both React now, so they share this one store. Persistence stays with the
 * page (A3): every change is announced one way (`insideSeam.ts`), and the initial value is read once from the
 * persisted view state.
 *
 * Ship's one-time auto-select (D234, replacing D142's hard pin): entering a new wait (the slot in confirm/retry on
 * a ticket/kind that has not selected Ship yet) moves the view to Ship so the preview is on screen beside the
 * always-clickable Confirm ship. It never re-selects: once a wait is recorded, further pushes (and a reload that
 * restores the record) leave the user wherever they navigated. Leaving the wait clears the record, so the next
 * confirm on this ticket is a new transition again.
 */
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { announcePersistSel, type PersistSel } from './insideSeam.js';

export interface SelectionSnapshot {
  readonly selected: string | null;
  /** Bumps on every change of the selection, including picking the stage already shown (which closes the stage menu). */
  readonly epoch: number;
}

const waits = (state: DashboardState): string | null => {
  const kind = state.ship?.kind;
  return kind === 'confirm' || kind === 'retry' ? `${state.ticketId}:${kind}` : null;
};

/** The stage the Inside block shows: the selection, else the ticket's own, else the one the user is about to start. */
export const shownStage = (selected: string | null, ticket: { readonly presentedStage?: string; readonly stageCurrent?: string }): string =>
  selected || ticket.presentedStage || ticket.stageCurrent || 'scope';

export class StageSelection {
  private snapshot: SelectionSnapshot;
  private shipWait: string | null;
  private readonly listeners = new Set<() => void>();

  /** `initial` state is the one the page restored: a wait already on screen selects Ship, but announces nothing yet. */
  constructor(persisted: PersistSel, initial: DashboardState | null) {
    this.snapshot = { selected: persisted.sel, epoch: 0 };
    this.shipWait = persisted.shipWait;
    if (initial) this.observe(initial, false);
  }

  readonly getSnapshot = (): SelectionSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The user picked a stage (a rail segment), or Back (null). */
  select(stage: string | null): void {
    this.set(stage);
    this.persist();
  }

  /** Every host message; only a full snapshot (not a live repaint, which is no render) can start a new wait. */
  receive(message: HostMessage): void {
    if (message.type === 'state' && message.live !== true) this.observe(message.state, true);
  }

  private observe(state: DashboardState, announce: boolean): void {
    const key = waits(state);
    if (key === this.shipWait) return;
    this.shipWait = key;
    if (key) this.set('ship');
    if (announce) this.persist();
  }

  private set(selected: string | null): void {
    this.snapshot = { selected, epoch: this.snapshot.epoch + 1 };
    for (const listener of [...this.listeners]) listener();
  }

  private persist(): void {
    announcePersistSel({ sel: this.snapshot.selected, shipWait: this.shipWait });
  }
}
