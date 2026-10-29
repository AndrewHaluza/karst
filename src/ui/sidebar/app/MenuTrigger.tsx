/**
 * The "⋯" trigger for the shared ticket-actions context window (Edit / Pause|Resume /
 * Create follow-up / Detach / Close / Reopen / Archive). A real button with menu semantics (`aria-haspopup` +
 * `aria-expanded`), used both in the collapsed hover strip and the expanded
 * toolbar. Secondary on purpose: Spin / Terminal / Dashboard stay outside it.
 * The host command guards the done-only follow-up rule itself, so the view never
 * second-guesses it; the other actions are shown only when the host's flags say they apply.
 */
import type { TicketRow } from '../state.js';
import { unlinkItems } from './CloudSessions.js';
import { Icon } from './Icon.js';
import { useSidebar, type MenuItem } from './SidebarContext.js';

export function ticketMenuItems(row: TicketRow): MenuItem[] {
  const id = row.ticketId;
  // Each conditional entry is host-gated (`paused` / `canDetach` / `canClose` / `canReopen`): the view only maps flags to items.
  return [
    { key: 'edit', spec: { act: 'edit', id }, label: 'Edit ticket', icon: 'pencil', title: 'Edit ticket' },
    row.paused
      ? { key: 'resume', spec: { act: 'unpause-ticket', id }, label: 'Resume execution', icon: 'player-play', title: 'Resume execution' }
      : { key: 'pause', spec: { act: 'pause-ticket', id }, label: 'Pause execution', icon: 'player-pause', title: 'Pause execution' },
    { key: 'follow', spec: { act: 'create-follow-up', id }, label: 'Create follow-up', icon: 'corner-down-right', title: 'Create a follow-up ticket' },
    ...(row.canDetach
      ? [{ key: 'detach', spec: { act: 'detach-subtask', id }, label: 'Detach from parent…', icon: 'unlink', title: 'Detach this sub-task from its parent and rebase it onto the root base' }]
      : []),
    ...(row.reviewStalled
      ? [
          { key: 'stall-hint', spec: { act: 'review-stall-hint', id }, label: 'Redesign hint…', icon: 'lightbulb', title: 'Review is stalled on the same files: send the fix agent a design hint and resume' },
          { key: 'stall-continue', spec: { act: 'review-stall-continue', id }, label: 'Continue anyway', icon: 'player-play', title: 'Review is stalled on the same files: reset the counter and keep fixing' },
          { key: 'stall-rescope', spec: { act: 'review-stall-rescope', id }, label: 'Re-scope', icon: 'pencil', title: 'Review is stalled on the same files: edit the ticket brief' },
        ]
      : []),
    ...(row.canClose
      ? [{ key: 'close', spec: { act: 'close-ticket', id }, label: 'Close — done outside Karst…', icon: 'circle-x', danger: true, title: 'Mark closed: the work was done outside Karst. Nothing is verified' }]
      : []),
    ...(row.canReopen
      ? [{ key: 'reopen', spec: { act: 'reopen-ticket', id }, label: 'Reopen', icon: 'history', title: 'Bring this closed ticket back to implementation' }]
      : []),
    {
      key: 'archive',
      spec: { act: 'archive', id },
      label: 'Archive',
      icon: 'archive',
      danger: true,
      divider: true,
      title: 'Archive ticket, hiding it from the active list',
    },
    ...unlinkItems(row),
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
