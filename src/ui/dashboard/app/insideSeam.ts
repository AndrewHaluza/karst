/**
 * Transitional seam between the React Inside block (and the rail beside it) and the vanilla page script (removed
 * in migration Phase 12, with the rest of the vanilla script). Three things Inside touches still live in
 * `webview.html`, so each is a window event and React never reaches into page functions:
 *
 *  - persistence (`vscode.setState`, A3) stays vanilla until the switch-over. React owns the stage selection and the
 *    Ship wait it has already auto-selected for, and tells the page after every change so the page can write them.
 *    One way only: React never reads them back from the page (it reads the persisted values once, at mount).
 *  - the terminal console surface is a page overlay (Phase 11). An Inside "view console" button announces which
 *    stage (and gate-lane process, if any) to open.
 *  - the page's Escape chain is ordered (ticket-data drawer, stage menu, console, logs, env, artifact view). The
 *    stage menu is React's now, so it tells the page whether it is open and the page yields Escape to it at the
 *    stage menu's place in the chain.
 */
export const PERSIST_SEL_EVENT = 'karst:persistSel';
export const OPEN_TERMINAL_EVENT = 'karst:openTerminal';
export const STAGE_MENU_OPEN_EVENT = 'karst:stageMenuOpen';

/** What the page persists beside the snapshot: the explicit selection (null = follow the ticket) and the Ship wait it was auto-selected for. */
export interface PersistSel {
  readonly sel: string | null;
  readonly shipWait: string | null;
}

/** React to the page: write this selection with the view state. */
export function announcePersistSel(detail: PersistSel): void {
  window.dispatchEvent(new CustomEvent<PersistSel>(PERSIST_SEL_EVENT, { detail }));
}

export interface OpenTerminal {
  readonly stage: string;
  /** The gate-lane AI process whose console to open; null = the stage's own console. */
  readonly processId: string | null;
}

/** React to the page: open the console surface (the page posts the log request). */
export function announceOpenTerminal(detail: OpenTerminal): void {
  window.dispatchEvent(new CustomEvent<OpenTerminal>(OPEN_TERMINAL_EVENT, { detail }));
}

/** React to the page: the stage menu opened (true) or closed (false). */
export function announceStageMenuOpen(open: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(STAGE_MENU_OPEN_EVENT, { detail: open }));
}
