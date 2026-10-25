/**
 * The header's "..." ticket-controls menu: Edit ticket, Pause / Resume execution, Create follow-up, the
 * "Link dashboard and terminal" quick setting and the per-ticket gate toggles. Same DOM as the vanilla markup,
 * `renderPause`, `renderFollowUp`, `renderBind` and `renderMenuGates` it replaced. The open state lives in
 * `Header` (one popover at a time).
 */
import { memo } from 'react';
import { useDashboardSend } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { HideableButton } from './HideableButton.js';
import { selectBind, selectControls, selectGates } from './headerSlices.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

type GateStage = 'uat' | 'review';

/** One toggle row for one resolved gate: a real switch whose runtime-pending state is set on click (UI-R11). */
function GateRow({ stage, name, disabled }: { readonly stage: GateStage; readonly name: string; readonly disabled: boolean }) {
  const send = useDashboardSend();
  const label = `${disabled ? 'Enable' : 'Disable'} ${name} for this ticket`;
  const onClick = usePendingAction((requestId) => send.setDisabledGates(stage, name, !disabled, requestId));
  return (
    <div className={disabled ? 'gateRow off' : 'gateRow'}>
      <span className="gateName">{name}</span>
      <label
        className="k-switch gateSwitch"
        role="switch"
        aria-checked={disabled ? 'false' : 'true'}
        aria-label={label}
        title={label}
        data-act="set-disabled-gates"
        data-stage={stage}
        data-name={name}
        data-disabled={disabled ? '1' : '0'}
        onClick={(e) => {
          // Like every posting control: the label's own forwarded click on the input must not toggle it.
          e.preventDefault();
          onClick(e);
        }}
      >
        <input type="checkbox" tabIndex={-1} />
        <span className="k-switch-track" />
      </label>
    </div>
  );
}

function Gates() {
  const gates = useSlice(selectGates);
  // Resolved async, host-side: nothing is drawn until the first answer, then the section is replaced wholesale.
  if (!gates) return null;
  const groups: ReadonlyArray<readonly [string, GateStage, typeof gates.uat]> = [
    ['UAT', 'uat', gates.uat || []],
    ['Review', 'review', gates.review || []],
  ];
  if (groups.every(([, , opts]) => opts.length === 0)) {
    return <div className="menuBlurb">No gates resolved for this ticket yet.</div>;
  }
  return (
    <>
      {groups.map(([title, stage, opts]) =>
        opts.length ? (
          <div key={stage} className="gateGroup">
            <div className="gateHead">{title}</div>
            {opts.map((o) => (
              <GateRow key={o.name} stage={stage} name={o.name} disabled={!!o.disabled} />
            ))}
          </div>
        ) : null,
      )}
    </>
  );
}

function LinkViewsSwitch() {
  const send = useDashboardSend();
  const bind = useSlice(selectBind);
  return (
    <label id="linkViewsLabel" className="k-switch" aria-checked={bind ? 'true' : 'false'} role="switch" aria-label="Link dashboard and terminal">
      {/* Payload-free: the host owns the preference and answers with the `bind` message, which is the terminal outcome (UI-R13). */}
      <input id="linkViews" type="checkbox" tabIndex={-1} checked={bind} onChange={() => send.toggleBind()} />
      <span className="k-switch-track" />
    </label>
  );
}

export const TicketMenu = memo(function TicketMenu({ open, onToggle }: { readonly open: boolean; readonly onToggle: () => void }) {
  const send = useDashboardSend();
  const controls = useSlice(selectControls);
  const paused = !!controls?.paused;
  const onEdit = usePendingAction((requestId) => send.editTicket(requestId));
  const onPause = usePendingAction((requestId) => send.pauseExecution(requestId));
  const onResume = usePendingAction((requestId) => send.unpauseExecution(requestId));
  const onFollowUp = usePendingAction((requestId) => send.createFollowUpTicket(requestId));
  return (
    <div className="menuWrap">
      <button
        id="moreBtn"
        type="button"
        className="k-iconbtn"
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-label="Ticket controls"
        title="Ticket controls"
        onClick={onToggle}
      >
        <Icon name="dots" />
      </button>
      <div id="menuPopover" className={open ? 'popover menuPopover open' : 'popover menuPopover hidden'} role="menu" aria-label="Ticket controls">
        <div className="menuHeading">Ticket</div>
        <button type="button" className="menuButton" data-act="edit-ticket" role="menuitem" onClick={onEdit}>
          <Icon name="pencil" />
          <span>Edit ticket</span>
        </button>
        <HideableButton off={paused} id="pauseItem" className="menuButton" data-act="pause-execution" role="menuitem" onClick={onPause}>
          <Icon name="player-pause" />
          <span>Pause execution</span>
        </HideableButton>
        <HideableButton off={!paused} id="resumeItem" className="menuButton" data-act="unpause-execution" role="menuitem" onClick={onResume}>
          <Icon name="player-play" />
          <span>Resume execution</span>
        </HideableButton>
        <HideableButton off={!controls?.done} id="followUpItem" className="menuButton" data-act="create-follow-up-ticket" role="menuitem" onClick={onFollowUp}>
          <Icon name="corner-down-right" />
          <span>Create follow-up</span>
        </HideableButton>
        <div className="menuDivider" />
        <div className="menuHeading">Quick setting</div>
        <div className="settingRow">
          <div className="settingCopy">
            <div className="settingTitle">Link dashboard ↔ terminal</div>
            <div className="settingHelp">Global · focusing either view brings the paired view forward.</div>
          </div>
          <LinkViewsSwitch />
        </div>
        <div className="menuDivider" />
        <div className="menuHeading">Gates for this ticket</div>
        <div id="menuGates" className="menuGates">
          <Gates />
        </div>
      </div>
    </div>
  );
});
