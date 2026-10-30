/**
 * The view pills (`data-region="views"`): Dashboard · Artifacts · Console · Server logs · Env variables, shown only while
 * a drill-down surface is open. Artifacts opens the index; Console opens its one stream directly, or a role=menu of
 * streams when there are several; Server logs opens the combined view directly; Env opens the editor. A pill with no
 * target is not rendered (`drillTargets.ts`). Every open goes through the overlay stack, so it lands on the history.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useOverlay, useOverlays } from './DashboardAppContext.js';
import { DASHBOARD } from './overlayStack.js';
import { Icon } from './Icon.js';
import { pillOf, viewPills, type ConsoleStream, type PillKey, type ViewPill } from './drillTargets.js';
import { useOverlayRoot } from './useOverlayRoot.js';
import { useSlice } from './useSlice.js';
import './ViewPills.css';

const streamKey = (s: ConsoleStream): string => `${s.stage}:${s.processId ?? ''}`;

function StreamMenu({ streams, onPick }: { readonly streams: readonly ConsoleStream[]; readonly onPick: (s: ConsoleStream) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div className="vp-menu" role="menu" aria-label="Console" onKeyDown={onKey}>
      {streams.map((s, i) => (
        <button key={streamKey(s)} ref={i === 0 ? first : undefined} type="button" role="menuitem" className="vp-item" onClick={() => onPick(s)}>
          <span className={`vp-dot ${s.status}`} aria-hidden="true" />
          <span className="vp-word">{s.word}</span>
          <span className="vp-label">{s.label}</span>
          {s.age ? <small>{s.age}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function ViewPills() {
  const overlays = useOverlays();
  const state = useSlice((s) => s.state);
  const console = useOverlay((s) => s.console);
  const logs = useOverlay((s) => s.logs);
  const env = useOverlay((s) => s.env);
  const art = useOverlay((s) => s.art);
  const view = { console, logs, env, art };
  const menuOpen = useOverlay((s) => s.pillMenu);
  const drill = pillOf(view) !== 'dashboard';
  const consolePill = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useOverlayRoot('viewsRoot', drill, 'views-nav');
  // Escape closed the menu: focus returns to the Console pill.
  useEffect(() => {
    if (wasOpen.current && !menuOpen) consolePill.current?.focus();
    wasOpen.current = menuOpen;
  }, [menuOpen]);
  if (!drill || !state) return null;

  const active = pillOf(view);
  const open = (pill: ViewPill): void => {
    if (pill.key === 'dashboard') overlays.goTo(DASHBOARD);
    else if (pill.key === 'artifacts') overlays.openIndex();
    else if (pill.key === 'logs') overlays.openLogs();
    else if (pill.key === 'env') overlays.openEnv();
    else if (pill.streams.length === 1) overlays.openConsole(pill.streams[0]!.stage, pill.streams[0]!.processId);
    else overlays.setPillMenuOpen(!menuOpen);
  };
  const pick = (s: ConsoleStream): void => {
    overlays.setPillMenuOpen(false);
    overlays.openConsole(s.stage, s.processId);
  };
  const aria = (p: ViewPill): string => (p.count === null ? p.label : `${p.label} (${p.count})`);
  return (
    <div className="vp-bar" role="toolbar" aria-label="Ticket views">
      {viewPills(state).map((p) => {
        const menu = p.key === 'console' && p.streams.length > 1;
        return (
          <span key={p.key} className="vp-slot">
            <button
              ref={p.key === 'console' ? consolePill : undefined}
              type="button"
              className="vp-pill"
              data-view={p.key satisfies PillKey}
              aria-current={active === p.key ? 'page' : undefined}
              aria-haspopup={menu ? 'menu' : undefined}
              aria-expanded={menu ? menuOpen : undefined}
              aria-label={aria(p)}
              title={p.label}
              onClick={() => open(p)}
            >
              <Icon name={p.icon} size={13} />
              <span className="vp-text">{p.label}</span>
              {p.count !== null ? <span className="vp-count">{p.count}</span> : null}
              {menu ? <Icon name="chevron-down" size={11} /> : null}
            </button>
            {menu && menuOpen ? <StreamMenu streams={p.streams} onPick={pick} /> : null}
          </span>
        );
      })}
    </div>
  );
}
