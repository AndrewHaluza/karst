/**
 * Root component for the dashboard React app (phase 1 shell).
 *
 * Sets `data-karst-ready` attribute on `document.documentElement` after the first commit
 * so `renderWebviewReady` waits until React has cleanly mounted into `#root`.
 *
 * Provides `DashboardAppProvider` wrapping the dashboard slices.
 */
import { useEffect } from 'react';
import type { DashboardHostBridge } from './hostBridge.js';
import { DashboardAppProvider, useDashboard } from './DashboardAppContext.js';
import { SandboxStrip } from './SandboxStrip.js';

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
    </DashboardAppProvider>
  );
}
