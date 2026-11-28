/**
 * The dashboard header, rendered by React into the page's static `.dhead` and `#headerMeta` roots (the region
 * parity snapshots pin both roots without an id or any data-* attribute, so the roots stay in webview.html).
 *
 * Popover: the ticket-controls menu (the agent switch lives in the runtime strip). A click anywhere else closes it
 * (another region, an overlay, the page itself); a click inside the header is decided here. Escape does not close them,
 * exactly as before the migration.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { HeaderMeta } from './HeaderMeta.js';
import { ModelsButton } from './ModelsButton.js';
import { RegionPortal } from './RegionPortal.js';
import { ShipControls } from './ShipControls.js';
import { TicketIdentity, TicketTitle } from './TicketIdentity.js';
import { TicketMenu } from './TicketMenu.js';
import { attachStickyHeader } from './stickyHeader.js';
import { announceSurfaceOpen, useSurfaceClose } from './useHoverCard.js';
import './Header.css';

type Popover = 'menu' | null;

/** True when the event's path passes through `selector`; the path survives a target the click itself detached (a picker option). */
function eventWithin(e: Event, selector: string): boolean {
  const t = e.target as Element | null;
  if (t?.closest?.(selector)) return true;
  return e.composedPath().some((node) => node instanceof Element && node.matches(selector));
}

function usePopovers(): { readonly open: Popover; readonly toggle: (which: 'menu') => void; readonly close: () => void } {
  const [open, setOpen] = useState<Popover>(null);
  const close = useCallback(() => setOpen(null), []);
  // Synchronous like the class toggle it replaced: the popover is open the moment the click returns.
  const toggle = useCallback(
    (which: 'menu') => {
      const next: Popover = open === which ? null : which;
      flushSync(() => setOpen(next));
      // One header surface at a time: opening the menu closes an open hover card (T1400).
      if (next !== null) announceSurfaceOpen('header-menu');
    },
    [open],
  );
  // ...and opening a hover card or a PR popover closes this menu.
  useSurfaceClose('header-menu', useCallback(() => flushSync(close), [close]));
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      // A click anywhere outside the header is outside every popover. Synchronous, like the class toggle it replaced.
      if (!eventWithin(e, '.dhead, #headerMeta')) {
        flushSync(close);
        return;
      }
      // A click inside the header, other than on the menu trigger or inside the menu itself, dismisses it like an
      // outside click. Matched on `#menuPopover`, not the generic `.popover`: the planning card is a `.popover` too,
      // and a click on it must not leave the menu open behind the card (T1400).
      if (eventWithin(e, '#moreBtn, #menuPopover')) return;
      close();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [close]);
  return { open, toggle, close };
}

export const Header = memo(function Header() {
  const { open, toggle, close } = usePopovers();
  const toggleMenu = useCallback(() => toggle('menu'), [toggle]);
  // The sticky row's observers own their DOM (the sentinel, `data-stuck`, the two custom properties).
  useEffect(() => attachStickyHeader(document), []);
  return (
    <>
      <RegionPortal byClass="dhead">
        <TicketIdentity />
        <TicketTitle />
        <div className="headerActions">
          <ShipControls />
          <ModelsButton />
          <TicketMenu open={open === 'menu'} onToggle={toggleMenu} onCloseMenu={close} />
        </div>
      </RegionPortal>
      <HeaderMeta />
    </>
  );
});
