/**
 * The Agents page: ONE place for agent identity. Two tabs —
 *
 *  - **Roles**: the preset selector, the roles table (every cell shows where its
 *    value comes from), the Default row and preset comparison;
 *  - **Agent profiles**: the reusable profiles with their real text, plus the
 *    built-in prompt behind each role.
 *
 * An edit always lands in the layer that wins — the pin when the role is pinned,
 * otherwise the selected preset — so no edit can be dead (`rolesModel.ts`).
 *
 * The location lives in the URL hash (`#agents/roles/<capability>`,
 * `#agents/profiles/<name>`, `?compare=<preset>`) so a reload restores it; an old
 * Presets link redirects to Roles. Tab switches keep both tabs' edits: every
 * edit is a draft edit in the shared reducer, and nothing here owns draft state.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { RolesTab } from './RolesTab.js';
import { BackendPanel } from './BackendPanel.js';
import { ProfilesTab } from './ProfilesTab.js';
import { formatAgentsHash, parseAgentsHash, type AgentsRoute, type AgentsTab } from './agentsRoute.js';

const TABS: readonly AgentsTab[] = ['roles', 'profiles'];

/**
 * What the unsaved bar is waiting on. A route move (another tab or profile) is
 * answered by entering that route; a Settings-section leave has no route of its
 * own, so the blocked switch is carried as the `proceed` it must run.
 */
type Awaiting =
  | { readonly kind: 'route'; readonly route: AgentsRoute }
  | { readonly kind: 'leave'; readonly proceed: () => void };

function readHash(): AgentsRoute {
  try {
    return parseAgentsHash(window.location.hash);
  } catch {
    return { tab: 'roles' };
  }
}

export function AgentsSection() {
  const { state, send, setLeaveGuard } = useSettingsApp();
  const [route, setRoute] = useState<AgentsRoute>(readHash);
  // Profile text being edited, by profile name. Owned HERE so it survives tab and
  // item switches; only a successful Save (or Discard) clears an entry.
  const [buffers, setBuffers] = useState<Readonly<Record<string, string>>>({});
  const setBuffer = useCallback((name: string, text: string | null) => {
    setBuffers((current) => {
      const next = { ...current };
      if (text === null) delete next[name];
      else next[name] = text;
      return next;
    });
  }, []);
  const rows = state.host?.agents ?? [];
  const dirtyNames = Object.keys(buffers).filter(
    (name) => rows.find((r) => r.name === name)?.body !== buffers[name],
  );
  const dirtyHere = route.tab === 'profiles' && route.selected !== undefined && dirtyNames.includes(route.selected)
    ? route.selected
    : null;
  // A move away from the item being edited asks first (Save / Discard / Keep editing).
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null);
  // Focus moves INTO the bar on Save (the safe default) and back to whatever
  // opened it on Escape / Keep editing (UI-R23, R27).
  const saveRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const refs = useRef<Record<AgentsTab, HTMLButtonElement | null>>({ roles: null, profiles: null });
  // Bumped when a resolved move must land focus on a profile item. The list
  // owns its item refs, so the request travels as a prop, not a DOM query.
  const [focusTick, setFocusTick] = useState(0);
  const barMessageId = useId();
  useEffect(() => {
    if (awaiting !== null) saveRef.current?.focus();
  }, [awaiting]);

  const ask = useCallback((next: Awaiting) => {
    const active = document.activeElement;
    returnRef.current = active instanceof HTMLElement ? active : null;
    setAwaiting(next);
  }, []);

  const go = useCallback(
    (next: AgentsRoute) => {
      const leaving = dirtyHere !== null && (next.tab !== 'profiles' || next.selected !== dirtyHere);
      if (leaving) ask({ kind: 'route', route: next });
      else setRoute(next);
    },
    [dirtyHere, ask],
  );

  // The section-leave guard: while a profile buffer is dirty, a Settings-section
  // switch must not unmount this page and silently drop it. The guard shows the
  // same bar and runs the blocked switch once the buffer is saved or discarded.
  useEffect(() => {
    if (dirtyNames.length === 0) {
      setLeaveGuard(null);
      return undefined;
    }
    setLeaveGuard((proceed) => {
      if (awaiting !== null) return true;
      ask({ kind: 'leave', proceed });
      return true;
    });
    return () => setLeaveGuard(null);
  }, [dirtyNames.length, awaiting, ask, setLeaveGuard]);

  /** Put focus back on the destination of a resolved route move. */
  const focusRoute = (next: AgentsRoute): void => {
    if (next.tab === 'roles') {
      refs.current.roles?.focus();
      return;
    }
    if (next.selected === undefined) {
      refs.current.profiles?.focus();
      return;
    }
    // The item is rendered by ProfilesTab, and the shell never reaches into the
    // DOM (R-X5): a tick asks that tab to focus the item it now shows selected.
    setFocusTick((tick) => tick + 1);
  };
  // What the bar's Save/Discard resolve: every buffer the bar is standing for
  // (one selected item on a route move, all of them on a section leave).
  const awaitedNames = (): readonly string[] =>
    awaiting?.kind === 'leave' ? dirtyNames : dirtyHere !== null ? [dirtyHere] : dirtyNames;

  const resolveAwaiting = (drop: boolean): void => {
    const target = awaiting;
    if (target === null) return;
    const names = awaitedNames();
    for (const name of names) {
      if (!drop) send.saveAgentFile(name, buffers[name] ?? '');
      setBuffer(name, null);
    }
    setAwaiting(null);
    if (target.kind === 'leave') {
      target.proceed();
      // The bar's Save/Discard unmounts with the page, so pointing focus at the
      // nav entry that asked keeps it from falling back to the document.
      returnRef.current?.focus();
    } else {
      setRoute(target.route);
      focusRoute(target.route);
    }
  };

  const onBarKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setAwaiting(null);
    returnRef.current?.focus();
  };

  // Mirror the route into the hash. The hash is a convenience (reload/links), so
  // an environment that refuses it must not break the page.
  useEffect(() => {
    try {
      const next = formatAgentsHash(route);
      if (window.location.hash !== next) window.history.replaceState(null, '', next);
    } catch {
      /* hash unavailable — the in-memory route still drives the page */
    }
  }, [route]);

  // A hash typed or followed while the page is open (back/forward, an old link).
  useEffect(() => {
    const onHash = (): void => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = go;

  const profileCount = (state.host?.agents ?? []).length;
  const labels: Record<AgentsTab, string> = {
    roles: 'Roles',
    profiles: `Agent profiles (${profileCount})`,
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: AgentsTab): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let next: AgentsTab | null = null;
    if (step !== 0) next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? tab;
    else if (event.key === 'Home') next = TABS[0] ?? tab;
    else if (event.key === 'End') next = TABS[TABS.length - 1] ?? tab;
    if (next === null) return;
    event.preventDefault();
    go({ tab: next });
    refs.current[next]?.focus();
  };

  return (
    <div className="section" id="section-agents">
      <div className="page-header" data-region="header">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-desc">
            Which agent runs each role, and the profiles behind them. An edit lands in the layer
            that wins: the pin if the role is pinned, otherwise the selected preset.
          </div>
        </div>
      </div>

      <BackendPanel />

      <div className="agents-tabs" role="tablist" aria-label="Agents" data-region="tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            ref={(el) => {
              refs.current[tab] = el;
            }}
            type="button"
            role="tab"
            id={`agents-tab-${tab}`}
            aria-selected={route.tab === tab}
            aria-controls={`agents-panel-${tab}`}
            tabIndex={route.tab === tab ? 0 : -1}
            className={`agents-tab${route.tab === tab ? ' is-active' : ''}`}
            onClick={() => go({ tab })}
            onKeyDown={(event) => onTabKey(event, tab)}
          >
            {labels[tab]}
            {tab === 'profiles' && dirtyNames.length > 0 ? (
              <span className="agents-dirty-dot" role="img" aria-label="unsaved changes" />
            ) : null}
          </button>
        ))}
      </div>

      {awaiting !== null ? (
        <div
          className="agents-unsaved"
          role="alertdialog"
          aria-label="Unsaved changes"
          aria-describedby={barMessageId}
          onKeyDown={onBarKeyDown}
        >
          <span id={barMessageId}>Unsaved changes to {awaitedNames().join(', ')}</span>
          <Button ref={saveRef} variant="primary" size="sm" onClick={() => resolveAwaiting(false)}>
            Save
          </Button>
          <Button variant="secondary" size="sm" onClick={() => resolveAwaiting(true)}>
            Discard
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAwaiting(null);
              returnRef.current?.focus();
            }}
          >
            Keep editing
          </Button>
        </div>
      ) : null}

      <div data-region="content" role="tabpanel" id={`agents-panel-${route.tab}`} aria-labelledby={`agents-tab-${route.tab}`}>
        {route.tab === 'roles' ? (
          <RolesTab route={route} navigate={navigate} />
        ) : (
          <ProfilesTab route={route} navigate={navigate} buffers={buffers} setBuffer={setBuffer} focusTick={focusTick} />
        )}
      </div>
    </div>
  );
}
