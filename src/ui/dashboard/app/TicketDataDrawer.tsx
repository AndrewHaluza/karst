/**
 * The Ticket details drawer: a slide-over over the dashboard, mirroring the ticket form's brief drawer (`.k-scrim`/
 * `.k-drawer` supply the surface; the open/closed transform and the scrim's fade stay in `TicketDataDrawer.css`).
 * Header (ids, provider link, actions, title), tabs (Brief / Original description / As sent to agent), the rendered
 * Markdown and a facts sidebar. The view model is composed when the drawer opens (`ticketDetails.ts`). Brief and
 * description are user- or provider-authored Markdown: data, never structure, rendered by the safe `MarkdownView`.
 * A pure page surface: opening it posts nothing (UI-R31); Copy/Open as Markdown and Edit are posting controls with
 * their own pending state. Focus moves to Close on open and returns to the trigger on close (the stack remembers it).
 *
 * Rendered into `#ticketDataHost`, a `display:contents` wrapper that takes the place the static scrim and aside held,
 * so the stacking order against the other fixed surfaces is unchanged.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { providerDisplayName } from '../../../model/briefSource.js';
import { useDashboardSend, useOverlay, useOverlays } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { MarkdownView } from './MarkdownView.js';
import { RegionPortal } from './RegionPortal.js';
import { Attachments, Comments, Facts } from './TicketDetailsParts.js';
import type { DetailsTabId, TicketDetailsView } from './ticketDetails.js';
import { usePendingAction } from './usePendingAction.js';
import './TicketDataDrawer.css';

const NO_CONTENT = 'No brief or description yet. Add one in the ticket form, or link a ticket from your tracker.';
const RAW_HINT = "exact Markdown in the agent's launch context";

/** The `data-act` is written at each use site as a literal: the parity guard reads acts from the source text. */
function IconAction({ 'data-act': act, label, icon, onPending }: { readonly 'data-act': string; readonly label: string; readonly icon: string; readonly onPending: (requestId: string) => void }) {
  const onClick = usePendingAction(onPending);
  return (
    <button type="button" className="k-iconbtn" data-act={act} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

function ProviderChip({ view }: { readonly view: TicketDetailsView }) {
  const send = useDashboardSend();
  const onClick = usePendingAction((requestId) => {
    if (view.ticketUrl) send.openTicketLink(view.ticketUrl, requestId);
  });
  if (view.ticketUrl && view.provider) {
    return (
      <a href="#" className="k-chip tdProvider" data-act="open-ticket-link" data-url={view.ticketUrl} onClick={(e) => { e.preventDefault(); onClick(e); }}>
        {providerDisplayName(view.provider)} ↗
      </a>
    );
  }
  return <span className="k-chip tdProvider">{view.provider ? providerDisplayName(view.provider) : 'karst ticket'}</span>;
}

function Head({ view, closeRef }: { readonly view: TicketDetailsView; readonly closeRef: React.RefObject<HTMLButtonElement | null> }) {
  const send = useDashboardSend();
  const overlays = useOverlays();
  const copyKey = usePendingAction((requestId) => send.copyTicketKey(requestId));
  return (
    <div className="tdDrawerHead">
      <div className="tdHeadLine">
        <span className="tdId">{view.idLabel}</span>
        {view.key ? (
          <>
            <span className="tdKey">{view.key}</span>
            <button type="button" className="k-iconbtn" data-act="copy-ticket-key" aria-label={`Copy ticket key ${view.key}`} title="Copy ticket key" onClick={copyKey}>
              <Icon name="copy" />
            </button>
          </>
        ) : null}
        <ProviderChip view={view} />
        <span className="tdHeadActions">
          <IconAction data-act="copy-ticket-markdown" label="Copy as Markdown" icon="copy" onPending={(r) => send.copyTicketMarkdown(view.text, r)} />
          <IconAction data-act="open-ticket-markdown" label="Open as Markdown in the editor" icon="markdown" onPending={(r) => send.openTicketMarkdown(view.text, r)} />
          <IconAction data-act="edit-ticket" label="Edit ticket" icon="pencil" onPending={(r) => send.editTicket(r)} />
          <button type="button" className="k-iconbtn" id="ticketDataClose" ref={closeRef} aria-label="Close ticket details" title="Close ticket details" onClick={overlays.closeTicketData}>
            <Icon name="x" />
          </button>
        </span>
      </div>
      <h3 id="ticketDataTitle" className="tdDrawerTitle">
        {view.title || view.idLabel}
      </h3>
    </div>
  );
}

function Tabs({ view, tab, onTab }: { readonly view: TicketDetailsView; readonly tab: DetailsTabId; readonly onTab: (t: DetailsTabId) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const ids = view.tabs.map((t) => t.id);
    const at = ids.indexOf(tab);
    const next = e.key === 'ArrowRight' ? (at + 1) % ids.length : e.key === 'ArrowLeft' ? (at - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onTab(ids[next]!);
    requestAnimationFrame(() => document.getElementById(`tdTab-${ids[next]}`)?.focus());
  };
  return (
    <div className="tdTabRow">
      <div className="tdTabs" role="tablist" aria-label="Ticket details" onKeyDown={onKeyDown}>
        {view.tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tdTab-${t.id}`} className="tdTab" aria-selected={t.id === tab} aria-controls="ticketDataPanel" tabIndex={t.id === tab ? 0 : -1} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {view.sourceLabel ? <span className="tdSource">{view.sourceLabel}</span> : null}
      {tab === 'raw' ? <span className="tdHint">{RAW_HINT}</span> : null}
    </div>
  );
}

function Main({ view, tab }: { readonly view: TicketDetailsView; readonly tab: DetailsTabId }) {
  if (tab === 'raw') return <pre className="tdRaw">{view.text}</pre>;
  if (tab === 'desc') return <MarkdownView markdown={view.original ?? ''} />;
  return (
    <>
      <MarkdownView markdown={view.main} />
      {view.planning ? (
        <section className="tdSection" aria-label="Planning brief">
          <h4 className="tdSectionTitle">Planning brief</h4>
          <MarkdownView markdown={view.planning} />
        </section>
      ) : null}
      <Comments comments={view.comments} />
      <Attachments attachments={view.attachments} />
    </>
  );
}

function DrawerBody({ view, tab }: { readonly view: TicketDetailsView; readonly tab: DetailsTabId }) {
  if (view.empty) return <p className="tdEmpty">{NO_CONTENT}</p>;
  return (
    <div className="tdLayout">
      {tab === 'raw' ? null : <Facts view={view} />}
      <div className="tdMain" id="ticketDataPanel" role="tabpanel" aria-labelledby={`tdTab-${tab}`}>
        <Main view={view} tab={tab} />
      </div>
    </div>
  );
}

export function TicketDataDrawer() {
  const overlays = useOverlays();
  const drawer = useOverlay((s) => s.drawer);
  const open = drawer !== null;
  const [shown, setShown] = useState<TicketDetailsView | null>(null);
  const [tab, setTab] = useState<DetailsTabId>('brief');
  if (drawer && drawer.view !== shown) {
    setShown(drawer.view);
    setTab('brief');
  }
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  return (
    <RegionPortal id="ticketDataHost">
      <div className={`k-scrim tdScrim${open ? ' open' : ''}`} id="ticketDataScrim" onClick={overlays.closeTicketData} />
      <aside className={`k-drawer tdDrawer${open ? ' open' : ''}`} id="ticketDataDrawer" role="dialog" aria-modal="true" aria-labelledby="ticketDataTitle" aria-hidden={open ? 'false' : 'true'}>
        {shown ? (
          <>
            <Head view={shown} closeRef={closeRef} />
            {shown.empty ? null : <Tabs view={shown} tab={tab} onTab={setTab} />}
            <div className="tdDrawerBody" id="ticketDataBody">
              <DrawerBody view={shown} tab={tab} />
            </div>
          </>
        ) : (
          <div className="tdDrawerBody" id="ticketDataBody" />
        )}
      </aside>
    </RegionPortal>
  );
}
