/**
 * The resources app's state container: the ONE place host pushes are reduced and
 * the ONLY bridge from a control to the host. Two read models live side by side —
 * the Resources tab's `ResourcesState` and the Servers tab's `ServersState` — plus
 * the terminal receipts (`action-result`) keyed by correlation id, which the
 * controls' mutations settle from (UI-R13).
 *
 * Nothing here interprets a message's payload: the host already formatted every
 * string (UI-R31), so the reducer only files each push where it belongs.
 */
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { DiskRowView, ResourcesState } from '../state.js';
import type { ServersState } from '../serversState.js';
import type { PanelTab, ResourcesHostMessage } from '../messages.js';
import { pageHostBridge, type ResourcesHostBridge } from './hostBridge.js';

export interface Receipt {
  readonly ok: boolean;
  readonly message: string | undefined;
}

export interface TabRequest {
  readonly tab: PanelTab;
  /** Bumped per request so asking for the same tab twice still fires. */
  readonly nonce: number;
}

export interface ResourcesAppState {
  readonly resources: ResourcesState | null;
  readonly servers: ServersState | null;
  /** Counts `servers` pushes; a stuck "unknown" control clears when a fresh read lands. */
  readonly serversSeq: number;
  readonly receipts: Readonly<Record<string, Receipt>>;
  readonly tabRequest: TabRequest | null;
}

const INITIAL: ResourcesAppState = {
  resources: null,
  servers: null,
  serversSeq: 0,
  receipts: {},
  tabRequest: null,
};

function withDisk(state: ResourcesState | null, rows: DiskRowView[]): ResourcesState | null {
  return state ? { ...state, disk: rows } : state;
}

export function resourcesAppReducer(state: ResourcesAppState, message: ResourcesHostMessage): ResourcesAppState {
  switch (message.type) {
    case 'state':
      return { ...state, resources: message.state };
    case 'disk':
      return { ...state, resources: withDisk(state.resources, message.rows) };
    case 'servers':
      return { ...state, servers: message.state, serversSeq: state.serversSeq + 1 };
    case 'show-tab':
      return { ...state, tabRequest: { tab: message.tab, nonce: (state.tabRequest?.nonce ?? 0) + 1 } };
    case 'action-result':
      return {
        ...state,
        receipts: { ...state.receipts, [message.requestId]: { ok: message.ok, message: message.message } },
      };
    default:
      return state;
  }
}

interface ResourcesApp {
  readonly state: ResourcesAppState;
  readonly bridge: ResourcesHostBridge;
}

const AppContext = createContext<ResourcesApp | null>(null);

export function ResourcesAppProvider({ bridge, children }: { bridge?: ResourcesHostBridge; children: ReactNode }) {
  const host = useMemo(() => bridge ?? pageHostBridge(), [bridge]);
  const [state, dispatch] = useReducer(resourcesAppReducer, INITIAL);
  useEffect(() => host.subscribe(dispatch), [host]);
  const value = useMemo(() => ({ state, bridge: host }), [state, host]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useResourcesApp(): ResourcesApp {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useResourcesApp must be used within ResourcesAppProvider');
  return ctx;
}
