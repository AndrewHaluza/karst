/**
 * The overlay views over the ticket dashboard (migration Phase 11): the ticket-data drawer, the artifact view, the
 * console, the server logs and the env-override editor, each drawn into the static root `webview.html` keeps for it.
 * Which one is open is the overlay stack's (`overlayStack.ts`); this is its single view, and the ONE owner of Escape.
 *
 * The page's ordered chain (drawer, stage menu, console, logs, env, baseline review, artifact view) is `OverlayStack.escape()`, except that an open baseline reject form takes the first Escape. It is
 * registered once, on the document in the bubble phase and before any region registers its own, so a press that closes an
 * overlay is claimed (`preventDefault`) ahead of a region's handler (the base-change form, the stage menu), which skips a
 * claimed press. A press that starts inside a dashboard region belongs to that region (`pageRegions.ts`), and a handler
 * nearer the target that stops the event first (the logs search field clearing itself) keeps it from the chain.
 */
import { useEffect, useRef } from 'react';
import { ArtifactOverlay } from './ArtifactView.js';
import { BaselineOverlay } from './BaselineOverlay.js';
import { useBaselineDraftsState, useOverlay, useOverlays } from './DashboardAppContext.js';
import { EnvOverlay } from './EnvView.js';
import { fromRegion } from './pageRegions.js';
import { ServerLogsView } from './ServerLogsView.js';
import { TerminalOverlay } from './TerminalView.js';
import { TicketDataDrawer } from './TicketDataDrawer.js';

export function Overlays() {
  const overlays = useOverlays();
  const logs = useOverlay((s) => s.logs);
  // The baseline review's reject form closes before the overlay does: the first Escape ends the form, the next the overlay.
  const drafts = useBaselineDraftsState();
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || fromRegion(e)) return;
      const form = draftsRef.current;
      if (overlays.getSnapshot().baselines && form.rejectOpen !== null) {
        form.closeReject();
        e.preventDefault();
        return;
      }
      if (overlays.escape()) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlays]);
  return (
    <>
      <TicketDataDrawer />
      <ArtifactOverlay />
      <TerminalOverlay />
      {logs ? <ServerLogsView /> : null}
      <EnvOverlay />
      <BaselineOverlay />
    </>
  );
}
