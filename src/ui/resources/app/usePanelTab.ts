/**
 * The selected tab, with the URL hash as its single source of truth (UI-R47):
 * `#servers` / `#resources`. A resize never touches it, and Back/Forward move it
 * because every selection is a hash navigation that the `hashchange` listener
 * reads. The webview's own `setState` is only the fallback for a reload that
 * lost the hash, and the host's `show-tab` (a command opening a specific tab)
 * is applied the same way as a click.
 */
import { useCallback, useEffect, useState } from 'react';
import type { PanelTab } from '../messages.js';
import type { ResourcesHostBridge } from './hostBridge.js';
import type { TabRequest } from './ResourcesAppContext.js';

const DEFAULT_TAB: PanelTab = 'resources';

function tabFromHash(): PanelTab | null {
  const hash = globalThis.location?.hash.replace(/^#/, '');
  return hash === 'servers' || hash === 'resources' ? hash : null;
}

export function usePanelTab(
  bridge: ResourcesHostBridge,
  request: TabRequest | null,
): readonly [PanelTab, (tab: PanelTab) => void] {
  const [tab, setTabState] = useState<PanelTab>(() => tabFromHash() ?? bridge.getState()?.tab ?? DEFAULT_TAB);

  const select = useCallback(
    (next: PanelTab) => {
      setTabState(next);
      bridge.setState({ tab: next });
      if (globalThis.location && tabFromHash() !== next) globalThis.location.hash = next;
    },
    [bridge],
  );

  useEffect(() => {
    const onHash = (): void => {
      const fromHash = tabFromHash();
      if (fromHash) {
        setTabState(fromHash);
        bridge.setState({ tab: fromHash });
      }
    };
    globalThis.addEventListener('hashchange', onHash);
    return () => globalThis.removeEventListener('hashchange', onHash);
  }, [bridge]);

  useEffect(() => {
    if (request) select(request.tab);
  }, [request, select]);

  return [tab, select];
}
