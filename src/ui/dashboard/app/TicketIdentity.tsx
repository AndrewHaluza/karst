/**
 * The header's ticket identity: provider mark, id badge, status chip, priority chip, copy-key button,
 * board link, the ticket-data preview button and, for a ticket filed from a planning draft, the `P<n>` link
 * (T1400), then the title. Same DOM as the vanilla `renderTicketIdentity` it replaced, plus the sidebar's
 * priority chip (T1396).
 * The key click copies (host-side) and the board link opens the board (a separate control).
 */
import { memo, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { ticketProviderLabel } from '../../../model/priority.js';
import { PriorityChip } from '../../shared/PriorityChip.js';
import { Icon } from './Icon.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { RuntimeIcon } from './AgentIcon.js';
import { selectIdentity } from './headerSlices.js';
import { PlanningLink } from './PlanningCard.js';
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
      data-tip={`Copy ticket key ${label}`}
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

const DataButton = memo(function DataButton() {
  const overlays = useOverlays();
  return (
    <button
      id="ticketDataBtn"
      type="button"
      className="k-iconbtn"
      data-act="preview-ticket-data"
      aria-label="Ticket details"
      title="Ticket details"
      // Synchronous, like the class toggle it replaced: the drawer is open the moment the click returns.
      onClick={() => flushSync(overlays.openTicketData)}
    >
      <Icon name="file-text" />
    </button>
  );
});

export const TicketIdentity = memo(function TicketIdentity() {
  const slice = useSlice(selectIdentity);
  const priority = slice?.priority ?? null;
  const full = slice ? ticketIdentityText(slice.idLabel, slice.key, slice.title) : undefined;
  // The provider's display name only ever rides the priority tooltip; with no provider there is none.
  const provider = slice?.provider ? { label: ticketProviderLabel(slice.provider), level: null } : undefined;
  return (
    <div className="ticketIdentity" aria-label={full} role="group">
      <span id="providerMark" className="provicon" aria-hidden="true">
        <RuntimeIcon kind="provider" provider={slice?.provider ?? ''} />
      </span>
      <span id="idBadge" className="k-id">
        {slice?.idLabel}
      </span>
      <span id="statusChip" className={`k-chip ticketStatus ${slice?.statusTone ?? 'info'}`} hidden={!slice?.statusWord}>
        {slice?.statusWord}
      </span>
      <PriorityChip
        id="priorityChip"
        level={priority?.level}
        text={priority?.text}
        source={priority?.source}
        reason={priority?.reason}
        provider={provider}
      />
      <CopyKeyButton label={slice?.key ?? ''} />
      <BoardLink url={slice?.ticketUrl ?? null} />
      <DataButton />
      {slice?.origin ? <PlanningLink origin={slice.origin} /> : null}
    </div>
  );
});

export const TicketTitle = memo(function TicketTitle() {
  const slice = useSlice(selectIdentity);
  return (
    <h1 id="title" className="ticketTitle" title={slice ? ticketIdentityText(slice.idLabel, slice.key, slice.title) : undefined} aria-label={slice ? ticketIdentityText(slice.idLabel, slice.key, slice.title) : undefined}>
      {slice?.title}
    </h1>
  );
});
