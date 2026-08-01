/**
 * The side-effects binding needs, injected so this module stays host-agnostic
 * (no `vscode`) and fully testable under vitest.
 */
export interface BinderDeps {
  /** The persisted starting value; read once, at construction. */
  isEnabled(): boolean;
  /** Persist the new value (real: `workspaceState.update`). */
  persist(enabled: boolean): void;
  /**
   * Open-or-reveal a ticket's dashboard WITHOUT taking focus. Opening is safe
   * here: a dashboard is a read-only view of the store, so creating one costs
   * nothing the user did not already ask for.
   */
  revealDashboard(ticketId: number): void;
  /**
   * Reveal a ticket's ALREADY-OPEN terminal without taking focus. Deliberately
   * not open-or-create: launching an agent spends tokens and mutates the ticket,
   * which must never be a side effect of clicking a tab.
   *
   * Returns whether a terminal was actually revealed. A ticket whose agent is
   * not running has none, and that no-op raises no activation — so the binder
   * must not sit waiting for one.
   */
  revealTerminal(ticketId: number): boolean;
  /** Push the new value to every open dashboard (the pref is window-wide). */
  broadcast(enabled: boolean): void;
}

/**
 * Two-way binding between a ticket's agent terminal and its dashboard panel
 * (§ bind toggle). Off by default; while on, activating either surface reveals
 * the other so one click shows both.
 *
 * Both reveals preserve focus, which keeps the caret where the user put it —
 * but it does NOT keep the reveal silent. `panel.reveal` makes the webview the
 * active editor of the active group and `terminal.show` makes the terminal the
 * active one, so each reveal raises the event that reveals the other, one turn
 * later. With two bound tickets in flight those echoes cross-feed and the
 * window switches tabs without ever settling (869echjjc).
 *
 * So a reveal is ANNOUNCED before it runs, and the activation it comes back as
 * is consumed instead of bound. That is the whole no-loop property: a
 * binder-initiated reveal is answered at most once, and its answer never starts
 * another reveal. A synchronous echo lands in the same slot, so this subsumes
 * the in-flight guard it replaces rather than sitting beside it.
 */
export class TerminalDashboardBinder {
  private isEnabled: boolean;
  /**
   * Reveals this binder asked for, awaiting the activation they raise. Panels
   * are a set — several can be revealed before the first echo lands — while the
   * terminal side is ONE slot, because the window has one active terminal: an
   * activation for any other ticket proves the announced one never became
   * active, so the expectation is dropped rather than left to swallow a later
   * visit the user actually made.
   */
  private readonly announcedDashboards = new Set<number>();
  private announcedTerminal: number | undefined;
  /** Overlapping suspensions (startup recovery); binding resumes at zero. */
  private suspensions = 0;

  constructor(private readonly deps: BinderDeps) {
    this.isEnabled = deps.isEnabled();
  }

  enabled(): boolean {
    return this.isEnabled;
  }

  /** Flip the binding, persist it, and tell every open dashboard. */
  toggle(): void {
    this.isEnabled = !this.isEnabled;
    this.deps.persist(this.isEnabled);
    this.deps.broadcast(this.isEnabled);
  }

  /**
   * Stop binding until the matching `resume`. Session recovery reveals
   * terminals the user never touched: binding off those would drag a dashboard
   * open per recovered ticket while the window is still coming up. Counted, so
   * two overlapping recoveries cannot release each other's suspension.
   */
  suspend(): void {
    this.suspensions++;
  }

  resume(): void {
    if (this.suspensions > 0) this.suspensions--;
  }

  /**
   * A Karst agent terminal became the active terminal. `ticketId` is undefined
   * for every other terminal in the window — those are ignored rather than
   * guessed at.
   */
  onTerminalActivated(ticketId: number | undefined): void {
    const announced = this.announcedTerminal;
    // Whatever is active now, it is not a terminal this binder is still waiting
    // on — either it is the one it revealed, or that reveal was overtaken.
    this.announcedTerminal = undefined;
    if (ticketId === undefined) return;
    // This binder revealed that terminal; the activation is its own echo.
    if (announced === ticketId) return;
    if (!this.bindable()) return;
    this.announcedDashboards.add(ticketId);
    this.deps.revealDashboard(ticketId);
  }

  /**
   * A ticket's dashboard panel changed view state. `active` is false on
   * deactivation — not the user landing on the dashboard, so only `true` binds.
   */
  onDashboardActivated(ticketId: number, active: boolean): void {
    if (!active) {
      // The panel is no longer active, so any activation still expected from a
      // reveal of it can never arrive. Drop the expectation rather than leave
      // it to swallow the user's next click on that panel.
      this.announcedDashboards.delete(ticketId);
      return;
    }
    if (this.announcedDashboards.delete(ticketId)) return;
    if (!this.bindable()) return;
    // Announced only if something was actually revealed — see `revealTerminal`.
    if (this.deps.revealTerminal(ticketId)) this.announcedTerminal = ticketId;
  }

  private bindable(): boolean {
    return this.isEnabled && this.suspensions === 0;
  }
}
