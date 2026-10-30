/**
 * The header's ticket identity: provider mark, id badge, copy-key button, priority chip, board link and the
 * ticket-data preview button, then the title. Same DOM as the vanilla `renderTicketIdentity` it replaced.
 * The key click copies (host-side) and the board link opens the board (a separate control).
 */
import { memo, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from './Icon.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { RuntimeIcon } from './AgentIcon.js';
import { selectIdentity } from './headerSlices.js';
import { usePendingAction } from './usePendingAction.js';
import { ticketIdentityText } from './ticketHead.js';
import { useSlice } from './useSlice.js';

/** How long the optimistic copy confirmation holds. */
const COPIED_MS = 1200;
const COPIED_TEXT = 'Copied ✓';

function CopyKeyButton({ label }: { readonly label: string }) {
  const send = useDashboardSend();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const onClick = usePendingAction((requestId) => {
    send.copyTicketKey(requestId);
    setCopied(true);
  });
  return (
    <button
      id="keyBtn"
      type="button"
      className="ticketKey"
      data-act="copy-ticket-key"
      data-copy=""
      title="Copy ticket key"
      aria-label={`Copy ticket key ${label}`}
      hidden={!label}
      disabled={copied}
      onClick={onClick}
    >
      {copied ? COPIED_TEXT : label}
    </button>
  );
}

function BoardLink({ url }: { readonly url: string | null }) {
  const send = useDashboardSend();
  const onPending = usePendingAction((requestId) => {
    if (url) send.openTicketLink(url, requestId);
  });
  return (
    <a
      id="boardLink"
      className="k-iconbtn"
      href="#"
      data-act="open-ticket-link"
      data-url={url ?? undefined}
      hidden={!url}
      aria-label="Open ticket in provider"
      title="Open ticket in provider"
      onClick={(e) => {
        e.preventDefault();
        onPending(e);
      }}
    >
      <Icon name="external-link" />
    </a>
  );
}

export const TicketIdentity = memo(function TicketIdentity() {
  const slice = useSlice(selectIdentity);
  const overlays = useOverlays();
  const priority = slice?.priority ?? '';
  const full = slice ? ticketIdentityText(slice.idLabel, slice.key, slice.title) : undefined;
  return (
    <div className="ticketIdentity" title={full} aria-label={full} role="group">
      <span id="providerMark" className="provicon" aria-hidden="true">
        <RuntimeIcon kind="provider" provider={slice?.provider ?? ''} />
      </span>
      <span id="idBadge" className="k-id">
        {slice?.idLabel}
      </span>
      <span id="statusChip" className={`k-chip ticketStatus ${slice?.statusTone ?? 'info'}`} hidden={!slice}>
        {slice?.statusWord}
      </span>
      <CopyKeyButton label={slice?.key ?? ''} />
      <span id="priorityChip" className="prio" hidden={!priority} aria-label={priority ? `Priority: ${priority}` : ''}>
        {priority}
      </span>
      <BoardLink url={slice?.ticketUrl ?? null} />
      <button
        id="ticketDataBtn"
        type="button"
        className="k-iconbtn"
        data-act="preview-ticket-data"
        aria-label="Preview ticket data"
        title="Preview ticket data"
        // Synchronous, like the class toggle it replaced: the drawer is open the moment the click returns.
        onClick={() => flushSync(overlays.openTicketData)}
      >
        <Icon name="file-text" />
      </button>
    </div>
  );
});

export const TicketTitle = memo(function TicketTitle() {
  const slice = useSlice(selectIdentity);
  return (
    <h1 id="title" className="ticketTitle" title={slice ? ticketIdentityText(slice.idLabel, slice.key, slice.title) : undefined}>
      {slice?.title}
    </h1>
  );
});
