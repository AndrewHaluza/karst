/**
 * The dashboard app's state and host bridge context.
 *
 * Provides the host snapshot store and the DashboardHostBridge to React components.
 * The provider is the only subscriber to host messages. The store and the bridge each
 * have a context that never changes identity, so a panel that selects a slice
 * (`useSlice`) is not re-rendered by a push that did not change its slice.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { DashboardHostBridge, DashboardSender } from './hostBridge.js';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { DashboardStore } from './dashboardStore.js';
import { OverlayStack, type OverlaySnapshot } from './overlayStack.js';
import { pageScroll } from './pageScroll.js';
import { PendingOps, type OpsSnapshot } from './pendingOps.js';
import { StageSelection, type SelectionSnapshot } from './stageSelection.js';
import { readPersisted, ViewPersistence, type PersistedView } from './viewPersistence.js';

const StoreContext = createContext<DashboardStore | null>(null);
const BridgeContext = createContext<DashboardHostBridge | null>(null);
const OpsContext = createContext<PendingOps | null>(null);
const SelectionContext = createContext<StageSelection | null>(null);
const OverlayContext = createContext<OverlayStack | null>(null);
const PersistenceContext = createContext<ViewPersistence | null>(null);

export function DashboardAppProvider({
  bridge,
  children,
  onSynced,
}: {
  bridge: DashboardHostBridge;
  children: ReactNode;
  /** Called once the provider is subscribed and the messages buffered before it have been committed to the DOM. */
  onSynced?: () => void;
}) {
  const [restored] = useState(() => readFromBridge(bridge));
  const [persistence] = useState(() => new ViewPersistence((envelope) => bridge.setState(envelope), restored));
  const [store] = useState(() => new DashboardStore(restored.state));
  const [ops] = useState(() => new PendingOps());
  const [selection] = useState(
    () => new StageSelection({ sel: restored.sel, shipWait: restored.shipWait }, store.getSnapshot().state, persistence.selection),
  );
  const [overlays] = useState(
    () =>
      new OverlayStack({
        send: bridge.send,
        getState: () => store.getSnapshot().state,
        scroll: pageScroll,
        persistArt: persistence.art,
        restored: { art: restored.art, scrolls: restored.scrolls, history: restored.history },
        // Back skips a detail whose artifact has since vanished.
        exists: (view) =>
          typeof view.art !== 'object' || view.art === null || (store.getSnapshot().state?.artifacts ?? []).some((x) => x.id === (view.art as { id: string }).id),
      }),
  );
  const [subscribed, setSubscribed] = useState(false);

  // The snapshot is held (and a real push written) first, so no write ever carries a stale one; then the shared
  // in-flight operations settle, and a new Ship wait selects Ship, from the same host messages every panel sees.
  useEffect(() => {
    const off = store.onMessage((message) => {
      persistence.receive(message);
      ops.receive(message);
      selection.receive(message);
      overlays.receive(message);
    });
    return () => {
      off();
      ops.dispose();
    };
  }, [store, persistence, ops, selection, overlays]);

  useEffect(() => {
    // Messages buffered before this subscription replay inside the call, i.e. inside this
    // effect, where a synchronous flush is not allowed; every later message flushes at once
    // so the DOM matches the host's push the moment it lands.
    let replaying = true;
    const unsubscribe = bridge.subscribe((message) => {
      if (replaying) store.receive(message);
      else flushSync(() => store.receive(message));
    });
    replaying = false;
    setSubscribed(true);
    return unsubscribe;
  }, [bridge, store]);

  // The render that follows `setSubscribed` also carries everything the replay absorbed, so this runs once the DOM
  // shows the restored or first state.
  useEffect(() => {
    if (subscribed) onSynced?.();
  }, [subscribed, onSynced]);

  return (
    <BridgeContext.Provider value={bridge}>
      <StoreContext.Provider value={store}>
        <OpsContext.Provider value={ops}>
          <SelectionContext.Provider value={selection}>
            <OverlayContext.Provider value={overlays}>
              <PersistenceContext.Provider value={persistence}>{children}</PersistenceContext.Provider>
            </OverlayContext.Provider>
          </SelectionContext.Provider>
        </OpsContext.Provider>
      </StoreContext.Provider>
    </BridgeContext.Provider>
  );
}

/** The persisted view state, tolerant of a `getState()` that throws. */
function readFromBridge(bridge: DashboardHostBridge): PersistedView {
  try {
    return readPersisted(bridge.getState());
  } catch {
    return readPersisted(null);
  }
}

/** The view-state writer: the servers filter starts from `srvFilter` and reports its changes with `filter`. */
export function usePersistence(): ViewPersistence {
  const persistence = useContext(PersistenceContext);
  if (!persistence) {
    throw new Error('usePersistence must be used within DashboardAppProvider');
  }
  return persistence;
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

/** The stage selection the rail and the Inside block share: re-renders only when it changes. */
export function useSelection(): { readonly selection: SelectionSnapshot; readonly select: StageSelection['select'] } {
  const store = useContext(SelectionContext);
  if (!store) {
    throw new Error('useSelection must be used within DashboardAppProvider');
  }
  const selection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const select = useCallback((stage: string | null) => store.select(stage), [store]);
  return { selection, select };
}

/** The overlay stack (drawer, console, logs, env, artifact view): open them here; the Escape chain is its `escape()`. */
export function useOverlays(): OverlayStack {
  const overlays = useContext(OverlayContext);
  if (!overlays) {
    throw new Error('useOverlays must be used within DashboardAppProvider');
  }
  return overlays;
}

/** One part of the overlay state; `select` must return a value that is stable while that part is unchanged. */
export function useOverlay<T>(select: (snapshot: OverlaySnapshot) => T): T {
  const overlays = useOverlays();
  return useSyncExternalStore(overlays.subscribe, () => select(overlays.getSnapshot()));
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
