/**
 * The dashboard app's state and host bridge context.
 *
 * Provides the host snapshot store and the DashboardHostBridge to React components.
 * The provider is the only subscriber to host messages. The store and the bridge each
 * have a context that never changes identity, so a panel that selects a slice
 * (`useSlice`) is not re-rendered by a push that did not change its slice.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { DashboardHostBridge, DashboardSender } from './hostBridge.js';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { DashboardStore } from './dashboardStore.js';
import { PendingOps, type OpsSnapshot } from './pendingOps.js';

const StoreContext = createContext<DashboardStore | null>(null);
const BridgeContext = createContext<DashboardHostBridge | null>(null);
const OpsContext = createContext<PendingOps | null>(null);

function restoreInitialState(bridge: DashboardHostBridge): DashboardState | null {
  try {
    const raw = bridge.getState();
    if (raw && typeof raw === 'object' && 'state' in raw && raw.state) {
      return raw.state as DashboardState;
    }
  } catch {
    // If state restore fails, start with null
  }
  return null;
}

export function DashboardAppProvider({
  bridge,
  children,
}: {
  bridge: DashboardHostBridge;
  children: ReactNode;
}) {
  const [store] = useState(() => new DashboardStore(restoreInitialState(bridge)));
  const [ops] = useState(() => new PendingOps());

  // The shared in-flight operations settle from the same host messages every panel sees.
  useEffect(() => {
    const off = store.onMessage((message) => ops.receive(message));
    return () => {
      off();
      ops.dispose();
    };
  }, [store, ops]);

  useEffect(() => {
    // Messages buffered before this subscription replay inside the call, i.e. inside this
    // effect, where a synchronous flush is not allowed; every later message flushes at once
    // so the DOM matches the host's push the moment it lands (as the vanilla renderer did).
    let replaying = true;
    const unsubscribe = bridge.subscribe((message) => {
      if (replaying) store.receive(message);
      else flushSync(() => store.receive(message));
    });
    replaying = false;
    return unsubscribe;
  }, [bridge, store]);

  return (
    <BridgeContext.Provider value={bridge}>
      <StoreContext.Provider value={store}>
        <OpsContext.Provider value={ops}>{children}</OpsContext.Provider>
      </StoreContext.Provider>
    </BridgeContext.Provider>
  );
}

export function useStore(): DashboardStore {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('useDashboard must be used within DashboardAppProvider');
  }
  return store;
}

/** The operations the rail, the header and the PR panel share (ship, merge): begin them here. */
export function usePendingOps(): PendingOps {
  const ops = useContext(OpsContext);
  if (!ops) {
    throw new Error('usePendingOps must be used within DashboardAppProvider');
  }
  return ops;
}

/** The shared operations' current state: re-renders only when one of them changes. */
export function useOps(): OpsSnapshot {
  const ops = usePendingOps();
  return useSyncExternalStore(ops.subscribe, ops.getSnapshot);
}

export function useDashboardBridge(): DashboardHostBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) {
    throw new Error('useDashboard must be used within DashboardAppProvider');
  }
  return bridge;
}

/** The whole snapshot's state plus the bridge: re-renders on every push. Prefer `useSlice`. */
export function useDashboard(): { readonly state: DashboardState | null; readonly bridge: DashboardHostBridge } {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, () => store.getSnapshot().state);
  return { state, bridge: useDashboardBridge() };
}

export function useDashboardState(): DashboardState | null {
  return useDashboard().state;
}

export function useDashboardSend(): DashboardSender {
  return useDashboardBridge().send;
}

/** Runs `handler` for every host message (after the snapshot absorbed it), without re-subscribing per render. */
export function useHostMessage(handler: (message: HostMessage) => void): void {
  const store = useStore();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => store.onMessage((message) => latest.current(message)), [store]);
}
