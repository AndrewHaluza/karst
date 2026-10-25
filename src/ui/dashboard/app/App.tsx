/**
 * Root component for the dashboard React app: the sandbox strip at `#root`, and every other region drawn into its
 * static root in `webview.html` through `RegionPortal`.
 *
 * Sets `data-karst-ready` on `document.documentElement` once the app is mounted and has applied the state it starts
 * from: the snapshot restored from `vscode.getState()` and anything the host pushed before the app subscribed (both
 * are in the DOM by then), so `renderWebviewReady` and the visual harness never read a half-drawn page.
 *
 * Provides `DashboardAppProvider` wrapping the dashboard slices.
 */
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
    // `data-react-owned` stays: the region parity snapshot pins this root's markup.
    <div data-karst-dashboard-app="true" data-react-owned="true" data-testid="dashboard-app-root">
      <SandboxStrip sandbox={state?.sandbox ?? null} send={bridge.send} />
    </div>
  );
}

const markReady = (): void => document.documentElement.setAttribute(READY_ATTR, 'true');

export function App({ bridge }: { bridge: DashboardHostBridge }) {
  return (
    <DashboardAppProvider bridge={bridge} onSynced={markReady}>
      <DashboardSlices />
      {/* Each region draws into its static root in webview.html. */}
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
      <RegionPortal region="worktrees">
        <WorktreesPanel />
      </RegionPortal>
    </DashboardAppProvider>
  );
}
