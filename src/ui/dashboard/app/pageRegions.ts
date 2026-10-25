/**
 * The regions of the ticket dashboard that handle their own keys (the header and its popovers, the rail, the Inside
 * block and its stage menu, the banner, the grid panels with the base-change form, the sandbox strip at `#root`). A key
 * pressed with focus inside one belongs to that region, not to the overlay stack: Escape closes the region's own
 * popover or form, and PageUp/PageDown inside a panel scroll the panel, not the console or the logs behind it.
 * The roots are the static shell in `webview.html`; the region parity snapshots pin them as markup.
 */
export const REGION_SELECTOR =
  '[data-react-owned], .dhead, #headerMeta, #rail, #inside, #blocked, #subtaskPanel, .svpanel, #worktreesPanel, .prpanel, #artPanel, #storedPanel';

/** True when the event started inside one of those regions. */
export function fromRegion(e: Event): boolean {
  const target = e.target as Partial<Element> | null;
  return typeof target?.closest === 'function' && target.closest(REGION_SELECTOR) !== null;
}
