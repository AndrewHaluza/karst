/**
 * The "⋯" trigger for the shared ticket-actions context window (Edit / Create
 * follow-up / Archive). A real button with menu semantics (`aria-haspopup` +
 * `aria-expanded`), used both in the collapsed hover strip and the expanded
 * toolbar. Secondary on purpose: Spin / Terminal / Dashboard stay outside it.
 * The host command guards the done-only follow-up rule itself, so the view never
 * second-guesses it.
 */
import type { TicketRow } from '../state.js';
import { Icon } from './Icon.js';
import { useSidebar, type MenuItem } from './SidebarContext.js';

export function ticketMenuItems(row: TicketRow): MenuItem[] {
  const id = row.ticketId;
  return [
    { key: 'edit', spec: { act: 'edit', id }, label: 'Edit ticket', icon: 'pencil', title: 'Edit ticket' },
    { key: 'follow', spec: { act: 'create-follow-up', id }, label: 'Create follow-up', icon: 'corner-down-right', title: 'Create a follow-up ticket' },
    {
      key: 'archive',
      spec: { act: 'archive', id },
      label: 'Archive',
      icon: 'archive',
      danger: true,
      title: 'Archive ticket, hiding it from the active list',
    },
  ];
}

export function MenuTrigger({ row }: { readonly row: TicketRow }) {
  const { menu, openMenu, closeMenu } = useSidebar();
  const menuOpen = menu?.owner === row.ticketId;
  return (
    <button
      type="button"
      className="k-iconbtn"
      data-menu={row.ticketId}
      aria-expanded={menuOpen}
      aria-haspopup="menu"
      aria-label="More ticket actions"
      title="More ticket actions"
      onClick={(e) => {
        // Pure view state, like the row's expand: settlement is the next render.
        if (menuOpen) closeMenu(true);
        else openMenu(e.currentTarget, row.ticketId, ticketMenuItems(row));
      }}
    >
      <Icon name="dots" />
    </button>
  );
}
