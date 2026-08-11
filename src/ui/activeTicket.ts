/**
 * Window-scoped knowledge of WHICH ticket's view is the currently ACTIVE view
 * (the focused dashboard / edit / diffs tab). The sidebar highlights that
 * ticket's row from this; nothing else consumes it.
 *
 * Each per-ticket panel manager reports raw activation via
 * `onDidChangeViewState` — including LOSING it — and this tracker folds the
 * reports into a single "active ticket" answer. It must survive reports
 * arriving in any order: VS Code fires one panel's `active=false` and the
 * next's `active=true` as separate events, and nothing guarantees their order,
 * so a deactivation only clears when it is STILL attributed to the ticket it
 * names. That guard is what makes a direct A→B tab switch settle on B whether
 * the events arrive as A-off,B-on or B-on,A-off.
 */
export class ActiveTicketTracker {
  private current: number | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * Report a view-state change for a ticket. `active=true` makes the ticket
   * current (the report is the newest focus); `active=false` clears it ONLY if
   * it is still the current one — an older panel going quiet must not steal the
   * highlight from the panel the user is actually on.
   */
  set(ticketId: number, active: boolean): void {
    const next = active ? ticketId : this.current === ticketId ? null : this.current;
    if (next === this.current) return;
    this.current = next;
    for (const cb of this.listeners) cb();
  }

  /** The ticket whose view is active right now, or null when none is. */
  get(): number | null {
    return this.current;
  }

  /** Subscribe to changes; no unsubscribe — the tracker lives with the window. */
  onDidChange(cb: () => void): void {
    this.listeners.add(cb);
  }
}
