/**
 * The dashboard header, rendered by React into the page's static `.dhead` and `#headerMeta` roots (the region
 * parity snapshots pin both roots without an id or any data-* attribute, so the roots stay in webview.html).
 *
 * Popovers: at most one of the agent switch form and the ticket-controls menu is open. A click anywhere else closes it
 * (another region, an overlay, the page itself); a click inside the header is decided here. Escape does not close them,
 * exactly as before the migration.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { AgentPopover } from './AgentPopover.js';
import { HeaderMeta } from './HeaderMeta.js';
import { RegionPortal } from './RegionPortal.js';
import { ShipControls } from './ShipControls.js';
import { TicketIdentity, TicketTitle } from './TicketIdentity.js';
import { TicketMenu } from './TicketMenu.js';
import './Header.css';

type Popover = 'agent' | 'menu' | null;

/** True when the event's path passes through `selector`; the path survives a target the click itself detached (a picker option). */
function eventWithin(e: Event, selector: string): boolean {
  const t = e.target as Element | null;
  if (t?.closest?.(selector)) return true;
  return e.composedPath().some((node) => node instanceof Element && node.matches(selector));
}

function usePopovers(): { readonly open: Popover; readonly toggle: (which: 'agent' | 'menu') => void; readonly close: () => void } {
  const [open, setOpen] = useState<Popover>(null);
  const close = useCallback(() => setOpen(null), []);
  // Synchronous like the class toggle it replaced: the popover is open the moment the click returns.
  const toggle = useCallback((which: 'agent' | 'menu') => flushSync(() => setOpen((current) => (current === which ? null : which))), []);
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      // A click anywhere outside the header is outside every popover. Synchronous, like the class toggle it replaced.
      if (!eventWithin(e, '.dhead, #headerMeta')) {
        flushSync(close);
        return;
      }
      // A click inside the header, other than on a trigger (which toggles) or inside a popover, dismisses like any outside click.
      if (eventWithin(e, '#agentButton, #moreBtn, .popover')) return;
      close();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [close]);
  return { open, toggle, close };
}

export const Header = memo(function Header() {
  const { open, toggle, close } = usePopovers();
  const toggleAgent = useCallback(() => toggle('agent'), [toggle]);
  const toggleMenu = useCallback(() => toggle('menu'), [toggle]);
  return (
    <>
      <RegionPortal byClass="dhead">
        <TicketIdentity />
        <TicketTitle />
        <div className="headerActions">
          <ShipControls />
          <AgentPopover open={open === 'agent'} onToggle={toggleAgent} close={close} />
          <TicketMenu open={open === 'menu'} onToggle={toggleMenu} />
        </div>
      </RegionPortal>
      <HeaderMeta />
    </>
  );
});
