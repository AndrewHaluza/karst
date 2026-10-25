/**
 * Transitional seam between the React artifact view and the vanilla page script (removed in migration Phase 12,
 * with the rest of the vanilla script). React owns which artifact surface is open and the scroll memory of every
 * surface, but never writes `vscode.setState` (A3): after each navigation it announces the view and the scroll
 * memory one way, and the page writes them with the rest of the view state. The initial values are read once from
 * the persisted view state (`restoreArt` in `overlayStack.ts`).
 */
import type { ArtScrolls, ArtView } from './overlayStack.js';

export const PERSIST_ART_EVENT = 'karst:persistArt';

/** What the page persists beside the snapshot: the artifact surface (null = the ticket) and each surface's scroll. */
export interface PersistArt {
  readonly artView: ArtView | null;
  readonly artScrolls: ArtScrolls;
}

/** React to the page: write this artifact view with the view state. */
export function announcePersistArt(detail: PersistArt): void {
  window.dispatchEvent(new CustomEvent<PersistArt>(PERSIST_ART_EVENT, { detail }));
}
