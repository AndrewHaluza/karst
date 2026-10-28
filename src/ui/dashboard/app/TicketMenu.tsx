/**
 * The header's "..." ticket-controls menu: Edit ticket, Pause / Resume execution, Create follow-up, Detach from
 * parent, Close, Reopen, the
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
function GateRow({
  stage,
  name,
  disabled,
  configOff = false,
}: {
  readonly stage: GateStage;
  readonly name: string;
  readonly disabled: boolean;
  readonly configOff?: boolean;
}) {
  const send = useDashboardSend();
  const label = `${disabled ? 'Enable' : 'Disable'} ${name} for this ticket`;
  const onClick = usePendingAction((requestId) => send.setDisabledGates(stage, name, !disabled, requestId));
  if (configOff) {
    // Off project-wide in Settings: a ticket cannot switch it back on, so no switch is offered.
    return (
      <div className="gateRow off">
        <span className="gateName">{name}</span>
        <span className="menuBlurb">off in Settings</span>
      </div>
    );
  }
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
              <GateRow key={o.name} stage={stage} name={o.name} disabled={!!o.disabled} configOff={!!o.configDisabled} />
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
  const onDetach = usePendingAction((requestId) => send.detachSubtask(requestId));
  const onClose = usePendingAction((requestId) => send.closeTicket(requestId));
  const onReopen = usePendingAction((requestId) => send.reopenTicket(requestId));
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
        {/* Detach (design NDL-70 5): offered only where the writer would allow it (host-derived `canDetachSubtask`). */}
        <HideableButton
          off={!controls?.canDetach}
          id="detachSubtask"
          className="menuButton"
          data-act="detach-subtask"
          role="menuitem"
          title="Detach this sub-task from its parent and rebase it onto the root base"
          onClick={onDetach}
        >
          <Icon name="unlink" />
          <span>Detach from parent…</span>
        </HideableButton>
        {/* Close / Reopen (@arch:STAGEMACH): a person records that the work was done outside karst. Host-gated
            (`canClose` / `canReopen`); the click sends no payload and the host asks for the reason. */}
        <HideableButton
          off={!controls?.canClose}
          id="closeTicket"
          className="menuButton danger"
          data-act="close-ticket"
          role="menuitem"
          title="Mark closed: the work was done outside Karst. Nothing is verified"
          onClick={onClose}
        >
          <Icon name="circle-x" />
          <span>Close — done outside Karst…</span>
        </HideableButton>
        <HideableButton
          off={!controls?.canReopen}
          id="reopenTicket"
          className="menuButton"
          data-act="reopen-ticket"
          role="menuitem"
          title="Bring this closed ticket back to implementation"
          onClick={onReopen}
        >
          <Icon name="history" />
          <span>Reopen</span>
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
