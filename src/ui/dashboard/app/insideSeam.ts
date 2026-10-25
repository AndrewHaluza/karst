/**
 * Transitional seam between the React Inside block (and the rail beside it) and the vanilla page script (removed
 * in migration Phase 12, with the rest of the vanilla script): persistence (`vscode.setState`, A3) stays vanilla until the
 * switch-over. React owns the stage selection and the Ship wait it has already auto-selected for, and tells the page
 * after every change so the page can write them. One way only: React never reads them back from the page (it reads the
 * persisted values once, at mount). The console and the stage menu's Escape place are the overlay stack's now
 * (`overlayStack.ts`), so they need no seam.
 */
export const PERSIST_SEL_EVENT = 'karst:persistSel';

/** What the page persists beside the snapshot: the explicit selection (null = follow the ticket) and the Ship wait it was auto-selected for. */
export interface PersistSel {
  readonly sel: string | null;
  readonly shipWait: string | null;
}

/** React to the page: write this selection with the view state. */
export function announcePersistSel(detail: PersistSel): void {
  window.dispatchEvent(new CustomEvent<PersistSel>(PERSIST_SEL_EVENT, { detail }));
}
