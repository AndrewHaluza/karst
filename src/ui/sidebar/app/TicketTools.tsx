/**
 * The ticket toolbar: Session, Pause/Resume, More. One source for the collapsed
 * row (where only the always-visible More is in flow) and the open row, so the
 * two never drift apart.
 */
import type { TicketRow } from '../state.js';
import { ActButton } from './action.js';
import { Icon } from './Icon.js';
import { IconAct } from './IconAct.js';
import { MenuTrigger } from './MenuTrigger.js';

/** Pause has no meaning for a finished ticket: done, closed (reopenable) and archived rows hide it. */
export function canPause(row: TicketRow): boolean {
  return !row.archived && !row.canReopen && row.stageCurrent !== 'done';
}

/** The Session tool. An `open-session` need has no button of its own, so it takes the amber ring. */
export function SessionTool({ row, sessVerb, tabIndex }: { readonly row: TicketRow; readonly sessVerb: string; readonly tabIndex?: number }) {
  const ring = row.peek?.needs?.cta.kind === 'open-session';
  return (
    <IconAct spec={{ act: 'open-session', id: row.ticketId }} label={`${sessVerb} session`} tabIndex={tabIndex} className={ring ? 'needs-ring' : undefined}>
      <Icon name="terminal-2" />
    </IconAct>
  );
}

/** The Pause/Resume toggle. One button; `aria-pressed` carries the paused state (UI-R28). */
export function PauseToggle({ row, tabIndex }: { readonly row: TicketRow; readonly tabIndex?: number }) {
  const paused = Boolean(row.paused);
  const label = paused ? 'Resume execution' : 'Pause execution';
  return (
    <ActButton
      spec={{ act: paused ? 'unpause-ticket' : 'pause-ticket', id: row.ticketId }}
      className={`k-iconbtn pausebtn${paused ? ' on' : ''}`}
      aria-pressed={paused}
      aria-label={label}
      title={label}
      tabIndex={tabIndex}
    >
      <Icon name={paused ? 'player-play' : 'player-pause'} />
    </ActButton>
  );
}

/**
 * The tools that appear on hover/focus at every width (SB-8, D860): Session and
 * Pause/Resume. The More menu is always visible in the row, in flow. In the tree
 * the row owns the only tab stop, so the tools are `tabIndex={-1}` (SB-6).
 */
export function HoverTools({ row, sessVerb, tabIndex }: { readonly row: TicketRow; readonly sessVerb: string; readonly tabIndex?: number }) {
  return (
    <>
      <SessionTool row={row} sessVerb={sessVerb} tabIndex={tabIndex} />
      {canPause(row) ? <PauseToggle row={row} tabIndex={tabIndex} /> : null}
    </>
  );
}

export function TicketTools({ row, sessVerb }: { readonly row: TicketRow; readonly sessVerb: string }) {
  return (
    <>
      <SessionTool row={row} sessVerb={sessVerb} />
      {canPause(row) ? <PauseToggle row={row} /> : null}
      <MenuTrigger row={row} />
    </>
  );
}
