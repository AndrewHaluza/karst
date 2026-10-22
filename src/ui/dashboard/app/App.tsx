/**
 * Root component for the dashboard React app (phase 1 shell).
 *
 * Sets `data-karst-ready` attribute on `document.documentElement` after the first commit
 * so `renderWebviewReady` waits until React has cleanly mounted into `#root`.
 *
 * Provides `DashboardAppProvider` wrapping the dashboard slices.
 */
import { useEffect } from 'react';
import { pageHostBridge, type DashboardHostBridge } from './hostBridge.js';
import { DashboardAppProvider } from './DashboardAppContext.js';

const READY_ATTR = ['data', 'karst', 'ready'].join('-');

export function App({ bridge = pageHostBridge() }: { bridge?: DashboardHostBridge }) {
  useEffect(() => {
    document.documentElement.setAttribute(READY_ATTR, 'true');
  }, []);

  return (
    <DashboardAppProvider bridge={bridge}>
      <div data-karst-dashboard-app="true" data-testid="dashboard-app-root">
        {/* Dashboard React slices mount here (e.g. V1 sandbox strip in T739) */}
      </div>
    </DashboardAppProvider>
  );
}
