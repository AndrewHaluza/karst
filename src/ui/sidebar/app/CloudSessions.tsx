/**
 * Cloud agent sessions (arch:CLOUD-01), display only: a cloud icon link on a
 * ticket row per session, and a row of its own for a session with no ticket
 * yet, mixed into the tickets list. Everything posts `cloud-session-*`; the
 * host re-validates the URL before any browser open or link.
 */
import type { CloudSessionChip, TicketRow, UnlinkedCloudSession } from '../state.js';
import { ActButton } from './action.js';
import { allRows, relTime } from './format.js';
import { Icon } from './Icon.js';
import { IconAct } from './IconAct.js';
import { useSidebar, type MenuItem } from './SidebarContext.js';

const openSpec = (url: string) => ({ act: 'cloud-session-open', url });

function groupByProvider(sessions: readonly CloudSessionChip[]): Map<string, CloudSessionChip[]> {
  const groups = new Map<string, CloudSessionChip[]>();
  for (const s of sessions) {
    const list = groups.get(s.provider);
    if (list) list.push(s);
    else groups.set(s.provider, [s]);
  }
  return groups;
}

export function sessionMenuItems(sessions: readonly CloudSessionChip[]): MenuItem[] {
  return sessions.map((c) => {
    const time = relTime(c.firstSeen);
    const label = time ? `${time} (${c.linkSource})` : c.linkSource;
    return {
      key: `cloud:${c.url}`,
      spec: openSpec(c.url),
      label,
      icon: 'cloud',
      title: `Open in ${c.label}`,
    };
  });
}

/** One icon link per provider; opens the session directly when 1, or a menu when several. */
export function CloudLinks({
  sessions,
  ticketId,
}: {
  readonly sessions: readonly CloudSessionChip[];
  readonly ticketId?: number;
}) {
  const { menu, openMenu, closeMenu } = useSidebar();
  const groups = groupByProvider(sessions);

  return (
    <span className="cloudlinks">
      {[...groups.entries()].map(([provider, providerSessions]) => {
        if (providerSessions.length === 1) {
          const c = providerSessions[0]!;
          return (
            <IconAct key={provider} spec={openSpec(c.url)} label={`Open in ${c.label}`} data-cloud="1">
              <Icon name="cloud" />
            </IconAct>
          );
        }
        const first = providerSessions[0]!;
        const owner = `cloud:${ticketId ?? ''}:${provider}`;
        const menuOpen = menu?.owner === owner;
        const label = `Open in ${first.label} · ${providerSessions.length} sessions`;
        return (
          <button
            key={provider}
            type="button"
            className="k-iconbtn"
            data-cloud="1"
            data-menu={owner}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={label}
            title={label}
            onClick={(e) => {
              if (menuOpen) closeMenu(true);
              else openMenu(e.currentTarget, owner, sessionMenuItems(providerSessions));
            }}
          >
            <Icon name="cloud" />
          </button>
        );
      })}
    </span>
  );
}

/** "Unlink" for each hand-made link on the ticket; scanned links are not the user's to undo. */
export function unlinkItems(row: TicketRow): MenuItem[] {
  const manual = (row.cloudSessions ?? []).filter((c) => c.linkSource === 'manual');
  return manual.map((c) => ({
    key: `unlink:${c.url}`,
    spec: { act: 'cloud-session-unlink', url: c.url },
    label: manual.length > 1 ? `Unlink cloud session …${c.url.slice(-6)}` : 'Unlink cloud session',
    icon: 'unlink',
    title: `Unlink ${c.label} from this ticket`,
  }));
}

/** Link targets: every listed ticket, then every pending draft. */
function linkItems(url: string, tickets: readonly TicketRow[], drafts: readonly { id: number; idLabel: string; title: string }[]): MenuItem[] {
  return [
    ...tickets.map((t) => ({
      key: `t${t.ticketId}`,
      spec: { act: 'cloud-session-link', url, id: t.ticketId },
      label: `${t.idLabel} ${t.label}`,
      icon: 'link',
      title: `Link to ticket ${t.idLabel}`,
    })),
    ...drafts.map((d) => ({
      key: `d${d.id}`,
      spec: { act: 'cloud-session-link', url, proposal: d.id },
      label: `${d.idLabel} ${d.title}`,
      icon: 'file-text',
      title: `Link to draft ${d.idLabel}`,
    })),
  ];
}

function CloudRow({ session }: { readonly session: UnlinkedCloudSession }) {
  const { state, menu, openMenu, closeMenu } = useSidebar();
  const owner = `c${session.id}`;
  const menuOpen = menu?.owner === owner;
  const drafts = (state.planning ?? []).flatMap((p) => p.proposals.filter((d) => d.status === 'pending'));
  return (
    <div className="ticket cloudrow" data-cloud-id={session.id}>
      <div className="row">
        <ActButton spec={openSpec(session.url)} className="k-btn k-btn--link k-btn--row rowopen" title={`Open in ${session.label}`}>
          <span className="glyph g-gray" aria-hidden="true"><Icon name="cloud" size={14} /></span>
          <span className="name">{session.label}</span>
          {session.proposalLabel ? <span className="k-chip" title={`Linked to draft ${session.proposalLabel}`}>{session.proposalLabel}</span> : null}
        </ActButton>
        <span className="rowacts">
          <button
            type="button"
            className="k-iconbtn"
            data-menu={owner}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="Link to…"
            title="Link to…"
            onClick={(e) => {
              if (menuOpen) closeMenu(true);
              else openMenu(e.currentTarget, owner, linkItems(session.url, allRows(state).filter((r) => !r.archived), drafts));
            }}
          >
            <Icon name="link" />
          </button>
        </span>
      </div>
    </div>
  );
}

/** The unlinked sessions as a block of rows; renders nothing when there are none. */
export function CloudSessionRows({ sessions }: { readonly sessions: readonly UnlinkedCloudSession[] }) {
  return <>{sessions.map((s) => <CloudRow key={s.id} session={s} />)}</>;
}
