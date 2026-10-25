/**
 * Root component for the dashboard React app (migration shell: the sandbox strip at `#root`,
 * migrated grid panels and the overlay views through `RegionPortal`).
 *
 * Sets `data-karst-ready` attribute on `document.documentElement` after the first commit
 * so `renderWebviewReady` waits until React has cleanly mounted into `#root`.
 *
 * Provides `DashboardAppProvider` wrapping the dashboard slices.
 */
import { useEffect } from 'react';
import type { DashboardHostBridge } from './hostBridge.js';
import { DashboardAppProvider, useDashboard } from './DashboardAppContext.js';
import { ArtifactsShelf } from './ArtifactsShelf.js';
import { BlockedBanner } from './BlockedBanner.js';
import { Header } from './Header.js';
import { Inside } from './Inside.js';
import { Overlays } from './Overlays.js';
import { PrsPanel } from './PrsPanel.js';
import { Rail } from './Rail.js';
import { RegionPortal } from './RegionPortal.js';
import { SandboxStrip } from './SandboxStrip.js';
import { ServersPanel } from './ServersPanel.js';
import { StoredPanel } from './StoredPanel.js';
import { SubtasksPanel } from './SubtasksPanel.js';
import { WorktreesPanel } from './WorktreesPanel.js';

const READY_ATTR = ['data', 'karst', 'ready'].join('-');

function DashboardSlices() {
  const { state, bridge } = useDashboard();
  return (
    // data-react-owned: transition rule — the vanilla document-level delegators in webview.html skip events from in here.
    <div data-karst-dashboard-app="true" data-react-owned="true" data-testid="dashboard-app-root">
      <SandboxStrip sandbox={state?.sandbox ?? null} send={bridge.send} />
    </div>
  );
}

export function App({ bridge }: { bridge: DashboardHostBridge }) {
  useEffect(() => {
    document.documentElement.setAttribute(READY_ATTR, 'true');
  }, []);

  return (
    <DashboardAppProvider bridge={bridge}>
      <DashboardSlices />
      {/* Migrated panels render into their existing containers in webview.html (data-react-owned there). */}
      <Header />
      <Rail />
      <Inside />
      <BlockedBanner />
      <SubtasksPanel />
      <ServersPanel />
      <PrsPanel />
      <ArtifactsShelf />
      <StoredPanel />
      <Overlays />
      <RegionPortal id="worktreesPanel">
        <WorktreesPanel />
      </RegionPortal>
    </DashboardAppProvider>
  );
}
