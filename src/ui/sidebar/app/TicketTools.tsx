/**
 * The ticket toolbar: Session, Pause/Resume, More. One component for the
 * collapsed hover strip and the open row, so the two never drift apart.
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

/** The Pause/Resume toggle. One button; `aria-pressed` carries the paused state (UI-R28). */
function PauseToggle({ row }: { readonly row: TicketRow }) {
  const paused = Boolean(row.paused);
  const label = paused ? 'Resume execution' : 'Pause execution';
  return (
    <ActButton
      spec={{ act: paused ? 'unpause-ticket' : 'pause-ticket', id: row.ticketId }}
      className={`k-iconbtn pausebtn${paused ? ' on' : ''}`}
      aria-pressed={paused}
      aria-label={label}
      title={label}
    >
      <Icon name={paused ? 'player-play' : 'player-pause'} />
    </ActButton>
  );
}

export function TicketTools({ row, sessVerb }: { readonly row: TicketRow; readonly sessVerb: string }) {
  const id = row.ticketId;
  // An `open-session` need has no button of its own, so the Session tool takes the amber ring.
  const ring = row.peek?.needs?.cta.kind === 'open-session';
  return (
    <>
      <IconAct spec={{ act: 'open-session', id }} label={`${sessVerb} session`} className={ring ? 'needs-ring' : undefined}>
        <Icon name="terminal-2" />
      </IconAct>
      {canPause(row) ? <PauseToggle row={row} /> : null}
      <MenuTrigger row={row} />
    </>
  );
}
