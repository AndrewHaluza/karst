/**
 * The dashboard app's state and host bridge context.
 *
 * Provides current DashboardState and DashboardHostBridge to React components.
 * Subscribes to host messages on mount and keeps state synchronized.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { DashboardHostBridge, DashboardSender } from './hostBridge.js';
import type { DashboardState } from '../state.js';

interface DashboardAppContextValue {
  readonly state: DashboardState | null;
  readonly bridge: DashboardHostBridge;
}

const DashboardAppContext = createContext<DashboardAppContextValue | null>(null);

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
  const [state, setState] = useState<DashboardState | null>(() => restoreInitialState(bridge));

  useEffect(() => {
    return bridge.subscribe((msg) => {
      if (msg.type === 'state') {
        setState(msg.state);
      }
    });
  }, [bridge]);

  return (
    <DashboardAppContext.Provider value={{ state, bridge }}>
      {children}
    </DashboardAppContext.Provider>
  );
}

export function useDashboard(): DashboardAppContextValue {
  const ctx = useContext(DashboardAppContext);
  if (!ctx) {
    throw new Error('useDashboard must be used within DashboardAppProvider');
  }
  return ctx;
}

export function useDashboardState(): DashboardState | null {
  return useDashboard().state;
}

export function useDashboardBridge(): DashboardHostBridge {
  return useDashboard().bridge;
}

export function useDashboardSend(): DashboardSender {
  return useDashboard().bridge.send;
}
