/**
 * Root component for the ticket-list sidebar webview.
 *
 * The page is an app shell, not a scrolling document: the toolbar, search box and
 * facet chips stay pinned and the ONLY thing that scrolls is the ticket list
 * (UI-R38). The app decides NOTHING about ticket state — every label, count,
 * section and next action arrives host-derived in the `state` snapshot (state.ts)
 * — and it keeps only view state (which rows are expanded, collapsed sub-trees,
 * the history disclosure, the Planning tree's focus), none of which reaches the
 * host. `data-karst-ready` is set after the first commit so `renderWebviewReady`
 * knows React has mounted into `#root`.
 */
import { useEffect, useMemo } from 'react';
import { ContextMenu } from './ContextMenu.js';
import { Facets } from './Facets.js';
import { pageHostBridge, type SidebarHostBridge } from './hostBridge.js';
import { SearchBox } from './SearchBox.js';
import { SidebarProvider } from './SidebarContext.js';
import { TicketList } from './TicketList.js';
import { Toolbar } from './Toolbar.js';

const READY_ATTR = ['data', 'karst', 'ready'].join('-');

export function App({ bridge }: { readonly bridge?: SidebarHostBridge }) {
  useEffect(() => {
    document.documentElement.setAttribute(READY_ATTR, 'true');
    return () => document.documentElement.removeAttribute(READY_ATTR);
  }, []);
  const host = useMemo(() => bridge ?? pageHostBridge(), [bridge]);
  return (
    <SidebarProvider bridge={host}>
      <Toolbar />
      <SearchBox />
      <Facets />
      <TicketList />
      <ContextMenu />
    </SidebarProvider>
  );
}
