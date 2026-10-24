/**
 * Root component for the "Servers & resources" webview.
 *
 * One page, two tabs, one panel lifecycle. `header` (title, scope line, tabs and
 * Refresh) is shared; each tab renders into its own `tabpanel`. Both panes stay
 * mounted so the Resources tab keeps its local presentation state (sort order,
 * muted series) across a tab switch. `data-karst-ready` is set after the first
 * commit so `renderWebviewReady` knows React has mounted into `#root`.
 */
import { useEffect } from 'react';
import { AnnouncerProvider, LiveRegion } from '../../settings/app/primitives/LiveRegion.js';
import { Button } from '../../settings/app/primitives/Button.js';
import type { ResourcesHostBridge } from './hostBridge.js';
import { ResourcesAppProvider, useResourcesApp } from './ResourcesAppContext.js';
import { useHostAction } from './useHostAction.js';
import { usePanelTab } from './usePanelTab.js';
import { Tabs, panelDomId, tabDomId } from './Tabs.js';
import { ResourcesPane } from './ResourcesPane.js';
import { ServersPane } from './ServersPane.js';

const READY_ATTR = ['data', 'karst', 'ready'].join('-');

function Shell() {
  const { state, bridge } = useResourcesApp();
  const [tab, selectTab] = usePanelTab(bridge, state.tabRequest);
  const refresh = useHostAction<[]>('Refresh', (requestId) => bridge.send.refresh(requestId));
  const resources = state.resources;
  const scope = state.servers?.scopeLabel || resources?.scopeLabel || '';

  return (
    <>
      <header className="rhead" data-region="header">
        <div className="titles">
          <h1>Servers &amp; resources</h1>
          <div className="sub">{scope}</div>
        </div>
        <div className="actions">
          <Button variant="secondary" busy={refresh.busy} spinning={refresh.spinning} disabled={refresh.disabled} onClick={() => refresh.trigger()}>
            Refresh
          </Button>
        </div>
        <Tabs selected={tab} onSelect={selectTab} />
      </header>

      <div
        role="tabpanel"
        id={panelDomId('servers')}
        aria-labelledby={tabDomId('servers')}
        data-region="servers"
        hidden={tab !== 'servers'}
      >
        <ServersPane state={state.servers} />
      </div>

      <div
        role="tabpanel"
        id={panelDomId('resources')}
        aria-labelledby={tabDomId('resources')}
        data-region="resources"
        hidden={tab !== 'resources'}
      >
        {resources && !resources.supported && (
          <div className="note plain">
            Resource monitoring is not supported on this platform. The status-bar meter is hidden; nothing here is measured.
          </div>
        )}
        {resources?.degraded && (
          <div className="note">
            The last reading did not complete — showing the previous numbers, which may be up to a minute old.
          </div>
        )}
        {resources?.supported && <ResourcesPane state={resources} />}
      </div>
    </>
  );
}

export function App({ bridge }: { bridge?: ResourcesHostBridge }) {
  useEffect(() => {
    document.documentElement.setAttribute(READY_ATTR, 'true');
  }, []);
  return (
    <AnnouncerProvider>
      <ResourcesAppProvider bridge={bridge}>
        <Shell />
      </ResourcesAppProvider>
      <LiveRegion />
    </AnnouncerProvider>
  );
}
