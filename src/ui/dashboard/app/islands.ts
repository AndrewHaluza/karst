/**
 * The dashboard regions that still own their own key handling. The region parity snapshots pin several of the roots
 * without any `data-*` attribute, so they cannot all carry `data-react-owned`; this selector names them (until
 * Phase 12). A key pressed with focus inside one belongs to that region, not to the overlay stack (the same
 * island rule the page's delegators applied before the overlays moved to React).
 */
export const ISLAND_SELECTOR = '[data-react-owned], .svpanel, .prpanel, #subtaskPanel, #artPanel, #storedPanel, .dhead, #headerMeta, #rail, #blocked, #inside';

/** True when the event started inside one of those regions. */
export function fromIsland(e: Event): boolean {
  const target = e.target as Partial<Element> | null;
  return typeof target?.closest === 'function' && target.closest(ISLAND_SELECTOR) !== null;
}
