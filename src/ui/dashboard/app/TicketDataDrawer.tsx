/**
 * The ticket-data preview: a slide-over drawer over the dashboard, mirroring the ticket form's brief drawer
 * (`.k-scrim`/`.k-drawer` supply the surface; the open/closed transform and the scrim's fade stay in
 * `TicketDataDrawer.css`). The body is the composed ticket-data text as TEXT: brief and description are user- or
 * provider-authored markdown, so they are data, never structure. A pure page surface: opening it posts nothing and needs
 * no host acknowledgement (UI-R31, no verdict is invented). Focus moves into the dialog on open and returns to the
 * trigger on close (the stack remembers it), per the modal-dialog contract.
 *
 * Rendered into `#ticketDataHost`, a `display:contents` wrapper that takes the place the static scrim and aside held, so the
 * stacking order against the other fixed surfaces is unchanged. The text composed at open stays in the closed drawer, as before.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useOverlay, useOverlays } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import './TicketDataDrawer.css';

export function TicketDataDrawer() {
  const overlays = useOverlays();
  const drawer = useOverlay((s) => s.drawer);
  const open = drawer !== null;
  const [text, setText] = useState('');
  if (drawer && drawer.text !== text) setText(drawer.text);
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  return (
    <RegionPortal id="ticketDataHost">
      <div className={`k-scrim tdScrim${open ? ' open' : ''}`} id="ticketDataScrim" onClick={overlays.closeTicketData} />
      <aside className={`k-drawer tdDrawer${open ? ' open' : ''}`} id="ticketDataDrawer" role="dialog" aria-modal="true" aria-labelledby="ticketDataTitle" aria-hidden={open ? 'false' : 'true'}>
        <div className="tdDrawerHead">
          <h3 id="ticketDataTitle" className="tdDrawerTitle">
            Ticket data
          </h3>
          <button type="button" className="k-iconbtn" id="ticketDataClose" ref={closeRef} aria-label="Close ticket data preview" title="Close ticket data preview" onClick={overlays.closeTicketData}>
            ✕
          </button>
        </div>
        <div className="tdDrawerBody" id="ticketDataBody">
          {text}
        </div>
      </aside>
    </RegionPortal>
  );
}
