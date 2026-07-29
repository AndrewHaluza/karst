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
   */
  revealTerminal(ticketId: number): void;
  /** Push the new value to every open dashboard (the pref is window-wide). */
  broadcast(enabled: boolean): void;
}

/**
 * Two-way binding between a ticket's agent terminal and its dashboard panel
 * (§ bind toggle). Off by default; while on, activating either surface reveals
 * the other so one click shows both.
 *
 * Both reveals preserve focus. That is the design, not a nicety: a reveal that
 * took focus would activate the counterpart, whose own listener would reveal
 * this side back, and the two would trade focus forever.
 */
export class TerminalDashboardBinder {
  private isEnabled: boolean;
  /**
   * True while a reveal is running. A host whose reveal DOES re-activate the
   * other surface would otherwise recurse; this bounds any such chain at one
   * hop, whatever the host's focus semantics turn out to be.
   */
  private revealing = false;

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
   * A Karst agent terminal became the active terminal. `ticketId` is undefined
   * for every other terminal in the window — those are ignored rather than
   * guessed at.
   */
  onTerminalActivated(ticketId: number | undefined): void {
    if (ticketId === undefined) return;
    this.reveal(() => this.deps.revealDashboard(ticketId));
  }

  /**
   * A ticket's dashboard panel changed view state. `active` is false on
   * deactivation and on a preserve-focus reveal — neither is the user landing
   * on the dashboard, so only `true` binds.
   */
  onDashboardActivated(ticketId: number, active: boolean): void {
    if (!active) return;
    this.reveal(() => this.deps.revealTerminal(ticketId));
  }

  private reveal(run: () => void): void {
    if (!this.isEnabled || this.revealing) return;
    this.revealing = true;
    try {
      run();
    } finally {
      this.revealing = false;
    }
  }
}
