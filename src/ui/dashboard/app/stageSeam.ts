/**
 * Transitional seam between the React stage rail and the vanilla page script (removed in migration
 * Phase 12, with the rest of the vanilla script). React owns the stage selection, but the Inside block
 * that renders it stays vanilla until Phase 10 and persistence (`vscode.setState`) stays vanilla until
 * the switch-over, so the selection travels both ways as window events:
 *
 *  - rail to page: the user picked a stage. The page sets its variable, re-renders Inside for it and persists.
 *  - page to rail: the page changed the selection itself (the one-time auto-select of Ship, Back to the
 *    current stage, an Inside control that names a stage) or is simply repainting. The page announces its
 *    current selection on every full render, so a rail that mounted late still converges.
 *
 * `null` means "no explicit selection": the rail falls back to the presented / current stage.
 */
export const SELECT_STAGE_EVENT = 'karst:selectStage';
export const STAGE_SELECTION_EVENT = 'karst:stageSelection';

/** React to the page: the user picked this stage in the rail. */
export function announceSelectStage(stage: string): void {
  window.dispatchEvent(new CustomEvent<string>(SELECT_STAGE_EVENT, { detail: stage }));
}

/** Page to React: the page's current explicit selection. */
export function onStageSelection(listener: (stage: string | null) => void): () => void {
  const handler = (e: Event): void => {
    const detail = (e as CustomEvent<unknown>).detail;
    listener(typeof detail === 'string' ? detail : null);
  };
  window.addEventListener(STAGE_SELECTION_EVENT, handler);
  return () => window.removeEventListener(STAGE_SELECTION_EVENT, handler);
}
