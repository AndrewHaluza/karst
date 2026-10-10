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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { RolesTab } from './RolesTab.js';
import { ProfilesTab } from './ProfilesTab.js';
import { formatAgentsHash, parseAgentsHash, type AgentsRoute, type AgentsTab } from './agentsRoute.js';

const TABS: readonly AgentsTab[] = ['roles', 'profiles'];

function readHash(): AgentsRoute {
  try {
    return parseAgentsHash(window.location.hash);
  } catch {
    return { tab: 'roles' };
  }
}

export function AgentsSection() {
  const { state, send } = useSettingsApp();
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
  const [awaiting, setAwaiting] = useState<AgentsRoute | null>(null);
  const go = useCallback(
    (next: AgentsRoute) => {
      const leaving = dirtyHere !== null && (next.tab !== 'profiles' || next.selected !== dirtyHere);
      if (leaving) setAwaiting(next);
      else setRoute(next);
    },
    [dirtyHere],
  );
  const refs = useRef<Record<AgentsTab, HTMLButtonElement | null>>({ roles: null, profiles: null });

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
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? tab;
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

      {awaiting !== null && dirtyHere !== null ? (
        <div className="agents-unsaved" role="alertdialog" aria-label="Unsaved changes">
          <span>Unsaved changes to {dirtyHere}</span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              send.saveAgentFile(dirtyHere, buffers[dirtyHere] ?? '');
              setBuffer(dirtyHere, null);
              setRoute(awaiting);
              setAwaiting(null);
            }}
          >
            Save
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setBuffer(dirtyHere, null);
              setRoute(awaiting);
              setAwaiting(null);
            }}
          >
            Discard
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAwaiting(null)}>
            Keep editing
          </Button>
        </div>
      ) : null}

      <div data-region="content" role="tabpanel" id={`agents-panel-${route.tab}`} aria-labelledby={`agents-tab-${route.tab}`}>
        {route.tab === 'roles' ? (
          <RolesTab route={route} navigate={navigate} />
        ) : (
          <ProfilesTab route={route} navigate={navigate} buffers={buffers} setBuffer={setBuffer} />
        )}
      </div>
    </div>
  );
}
