/**
 * The sidebar app's one store: the host snapshot plus the VIEW state that
 * survives re-renders and never reaches the host (which rows are expanded, which
 * sub-trees are collapsed, the history disclosure, the Planning tree's expanded
 * sessions and roving focus, the open context window).
 *
 * It also owns the host feed: the snapshot (`state`), the window-configuration
 * side channel (`edge`) and `action-result` receipts all arrive here, and the
 * single posting path (`fire`) leaves from here.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { PlanningRow, SidebarState } from '../state.js';
import type { ActionSpec } from './action.js';
import { allRows, EMPTY_STATE } from './format.js';
import type { OutboundMessage, SidebarHostBridge } from './hostBridge.js';
import { PlanNotes } from './planNotes.js';
import { activePreset, presetToggles, type PresetId, PRESETS } from './presets.js';
import { ds } from './runtime.js';
import { restoreView, type PaneKey, type ViewState } from './viewState.js';

/** One entry of the shared context window. */
export interface MenuItem {
  readonly key: string;
  readonly spec: ActionSpec;
  readonly label: string;
  readonly icon: string;
  readonly danger?: boolean;
  /** Draw a separator line before this entry. */
  readonly divider?: boolean;
  readonly title?: string;
}

/** The context window is open for `owner` (a ticket id or a Planning node id), anchored at `trigger`. */
export interface MenuState {
  readonly owner: number | string;
  readonly trigger: HTMLElement;
  readonly items: readonly MenuItem[];
}

export interface SidebarContextValue {
  readonly state: SidebarState;
  readonly post: (message: OutboundMessage) => void;
  readonly fire: (spec: ActionSpec, el: HTMLElement, e?: MouseEvent) => void;
  /** Apply a Tickets preset through the existing `toggle-facet` messages. */
  readonly applyPreset: (id: PresetId) => void;

  /** Pure view state (collapsed panes, archived planning toggle): persisted in the webview state, never posted. */
  readonly view: ViewState;
  readonly togglePane: (pane: PaneKey) => void;
  readonly toggleShowArchivedPlans: () => void;
  /** Sessions whose accepted drafts the user has revealed. */
  readonly acceptedOpen: ReadonlySet<number>;
  readonly toggleAccepted: (sessionId: number) => void;

  readonly openIds: ReadonlySet<number>;
  readonly toggleOpen: (ticketId: number) => void;
  readonly collapsedSubtrees: ReadonlySet<number>;
  readonly toggleSubtree: (ticketId: number) => void;
  /** `user` separates an explicit click (which sticks) from the automatic search reveal. */
  readonly hist: { readonly open: boolean; readonly user: boolean };
  readonly toggleHist: () => void;

  readonly planOpen: ReadonlyMap<number, boolean>;
  readonly setPlanOpen: (sessionId: number, open: boolean) => void;
  readonly collapseAllPlans: () => void;
  readonly planFocus: string | null;
  readonly setPlanFocus: (node: string | null) => void;

  readonly menu: MenuState | null;
  readonly openMenu: (trigger: HTMLElement, owner: number | string, items: readonly MenuItem[]) => void;
  readonly closeMenu: (returnFocus: boolean) => void;
}

const Ctx = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSidebar: no SidebarProvider above this component');
  return value;
}

/** Restore a prior snapshot defensively: a pre-upgrade one can predate fields the view reads. */
function restore(prev: SidebarState | undefined): SidebarState {
  return prev ? { ...EMPTY_STATE, ...prev } : EMPTY_STATE;
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function SidebarProvider({ bridge, children }: { readonly bridge: SidebarHostBridge; readonly children: ReactNode }) {
  const [state, setState] = useState<SidebarState>(() => restore(bridge.getState()));
  const [view, setView] = useState<ViewState>(() => restoreView(bridge.getState()?.view));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [acceptedOpen, setAcceptedOpen] = useState<ReadonlySet<number>>(new Set());
  const stateRef = useRef(state);
  const notes = useRef(new PlanNotes());

  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());
  const [collapsedSubtrees, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [hist, setHist] = useState({ open: false, user: false });
  const [planOpen, setPlanOpenMap] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [planFocus, setPlanFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;

  const closeMenu = useCallback((returnFocus: boolean) => {
    const open = menuRef.current;
    if (!open) return;
    menuRef.current = null;
    setMenu(null);
    if (returnFocus && typeof open.trigger.focus === 'function') open.trigger.focus();
  }, []);

  const openMenu = useCallback((trigger: HTMLElement, owner: number | string, items: readonly MenuItem[]) => {
    const next: MenuState = { owner, trigger, items };
    menuRef.current = next;
    setMenu(next);
  }, []);

  useEffect(
    () =>
      bridge.subscribe((msg) => {
        if (msg.type === 'edge') {
          // Which side faces the editor — host-resolved window configuration, not
          // ticket data. 'none' clears the attribute.
          const side = msg.side === 'left' || msg.side === 'right' ? msg.side : '';
          if (side) document.documentElement.setAttribute('data-edge', side);
          else document.documentElement.removeAttribute('data-edge');
        } else if (msg.type === 'state') {
          const next = msg.state;
          stateRef.current = next;
          bridge.setState({ ...next, view: viewRef.current });
          setState(next);
          // Prune expanded ids that no longer exist so the set can't grow unbounded.
          const ids = new Set(allRows(next).map((r) => r.ticketId));
          setOpenIds((prev) => {
            const kept = [...prev].filter((id) => ids.has(id));
            return kept.length === prev.size ? prev : new Set(kept);
          });
          // The context window is anchored to a trigger inside rows that may be
          // redrawn, so a state push always closes it.
          closeMenu(false);
          notes.current.announceNew(next.planning || []);
        } else if (msg.type === 'action-result') {
          notes.current.settle(msg.requestId, msg.ok, msg.message);
        }
      }),
    [bridge, closeMenu],
  );

  const post = bridge.post;

  const fire = useCallback(
    (spec: ActionSpec, el: HTMLElement, e?: MouseEvent) => {
      if (ds.isPending(el) || (el as HTMLButtonElement).disabled) {
        e?.preventDefault();
        return;
      }
      const type = spec.act ?? 'open-ticket';
      const requestId = ds.requestId();
      ds.beginPending(el, requestId);
      const ticketId = spec.act ? spec.id : spec.open;
      const payload: Record<string, unknown> = { type, requestId };
      if (ticketId !== undefined) payload.ticketId = Number(ticketId);
      // Planning rows carry a session id, never a ticket id.
      if (spec.plan !== undefined) payload.sessionId = spec.plan;
      if (spec.proposal !== undefined) payload.proposalId = spec.proposal;
      // resolve-conflicts carries the conflicted repo so the host re-verifies it.
      if (spec.repo) payload.repo = spec.repo;
      if (spec.url) payload.url = spec.url;
      notes.current.note(type, requestId, spec.plan, stateRef.current.planning || ([] as PlanningRow[]));
      post(payload as unknown as OutboundMessage);
    },
    [post],
  );

  const applyPreset = useCallback(
    (id: PresetId) => {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset || activePreset(stateRef.current.facets || ['all'])?.id === id) return;
      closeMenu(false);
      for (const facet of presetToggles(preset)) post({ type: 'toggle-facet', facet });
    },
    [closeMenu, post],
  );

  // View state is persisted with the last snapshot so a reloaded webview restores it.
  useEffect(() => {
    bridge.setState({ ...stateRef.current, view });
  }, [bridge, view]);
  const togglePane = useCallback((pane: PaneKey) => {
    setView((v) => ({ ...v, collapsed: { ...v.collapsed, [pane]: !v.collapsed[pane] } }));
  }, []);
  const toggleShowArchivedPlans = useCallback(() => {
    setView((v) => ({ ...v, showArchivedPlans: !v.showArchivedPlans }));
  }, []);
  const toggleAccepted = useCallback((sessionId: number) => {
    setAcceptedOpen((prev) => toggled(prev, sessionId));
  }, []);

  const toggleOpen = useCallback(
    (id: number) => {
      closeMenu(false);
      setOpenIds((prev) => toggled(prev, id));
    },
    [closeMenu],
  );
  const toggleSubtree = useCallback(
    (id: number) => {
      closeMenu(false);
      setCollapsed((prev) => toggled(prev, id));
    },
    [closeMenu],
  );
  const toggleHist = useCallback(() => {
    closeMenu(false);
    // Explicit click: this choice STICKS (survives searches and re-renders).
    setHist((h) => ({ open: !h.open, user: true }));
  }, [closeMenu]);

  const setPlanOpen = useCallback((sessionId: number, open: boolean) => {
    setPlanOpenMap((prev) => new Map(prev).set(sessionId, open));
  }, []);
  const collapseAllPlans = useCallback(() => {
    setPlanOpenMap((prev) => {
      const next = new Map(prev);
      for (const p of stateRef.current.planning || []) next.set(p.sessionId, false);
      return next;
    });
  }, []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      state, post, fire, applyPreset, view, togglePane, toggleShowArchivedPlans, acceptedOpen, toggleAccepted,
      openIds, toggleOpen, collapsedSubtrees, toggleSubtree, hist, toggleHist,
      planOpen, setPlanOpen, collapseAllPlans, planFocus, setPlanFocus,
      menu, openMenu, closeMenu,
    }),
    [state, post, fire, applyPreset, view, togglePane, toggleShowArchivedPlans, acceptedOpen, toggleAccepted, openIds, toggleOpen, collapsedSubtrees, toggleSubtree, hist, toggleHist, planOpen, setPlanOpen, collapseAllPlans, planFocus, menu, openMenu, closeMenu],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
