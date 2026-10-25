/**
 * Transitional seam between the React Artifacts shelf / Captured artifacts panels and the vanilla page
 * script (removed in migration Phase 12, with the rest of the vanilla script). The full-screen artifact
 * view (index, detail, stored) is still vanilla and owns `artView`, its persistence and its scroll
 * memory, so the panels announce what to open as a window event the page script listens for.
 */
export const OPEN_ART_EVENT = 'karst:openArt';

export type OpenArt = { readonly kind: 'index' } | { readonly kind: 'stored' } | { readonly kind: 'artifact'; readonly id: string };

export function announceOpenArt(detail: OpenArt): void {
  window.dispatchEvent(new CustomEvent<OpenArt>(OPEN_ART_EVENT, { detail }));
}
