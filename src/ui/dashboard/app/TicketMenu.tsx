/**
 * The header's "..." ticket-controls menu: Edit ticket, Pause / Resume execution, Create follow-up, Detach from
 * parent, Close, Reopen, Archive, the
 * "Link dashboard and terminal" quick setting and the per-ticket gate toggles. Same DOM as the vanilla markup,
 * `renderPause`, `renderFollowUp`, `renderBind` and `renderMenuGates` it replaced. The open state lives in
 * `Header` (one popover at a time).
 */
import { memo, useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { HideableButton } from './HideableButton.js';
import { LayoutSetting } from './LayoutSetting.js';
import { selectBind, selectControls, selectGates, selectIdentity, selectStageCurrent } from './headerSlices.js';
import type { GateOption } from '../gateOptions.js';
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

function Gates({ open }: { readonly open: boolean }) {
  const gates = useSlice(selectGates);
  const stageCurrent = useSlice(selectStageCurrent);
  // Each open starts on the ticket's current stage; a tab the user picks stays picked while the menu is open
  // (a 1 Hz state push must not jump tabs under the pointer). Closing resets it so the next open starts fresh.
  const defaultTab: GateStage = stageCurrent === 'review' ? 'review' : 'uat';
  const [picked, setPicked] = useState<GateStage | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setPicked(open ? defaultTab : null);
  }
  // Resolved async, host-side: nothing is drawn until the first answer, then the section is replaced wholesale.
  if (!gates) return null;
  const groups: ReadonlyArray<readonly [string, GateStage, readonly GateOption[]]> = [
    ['UAT', 'uat', gates.uat || []],
    ['Review', 'review', gates.review || []],
  ];
  const nonEmpty = groups.filter(([, , opts]) => opts.length > 0);
  if (nonEmpty.length === 0) {
    return <div className="menuBlurb">No gates resolved for this ticket yet.</div>;
  }
  if (nonEmpty.length === 1) {
    // One stage only: no tab row is noise; keep the head the stacked layout always had.
    const [title, stage, opts] = nonEmpty[0]!;
    return (
      <div className="gateGroup">
        <div className="gateHead">{title}</div>
        {opts.map((o) => (
          <GateRow key={`${stage}:${o.name}`} stage={stage} name={o.name} disabled={!!o.disabled} configOff={!!o.configDisabled} />
        ))}
      </div>
    );
  }
  const active: GateStage = picked ?? defaultTab;
  const activeGroup = nonEmpty.find(([, stage]) => stage === active) ?? nonEmpty[0]!;
  const stages = nonEmpty.map(([, stage]) => stage);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = stages.indexOf(active);
    const target =
      e.key === 'ArrowRight'
        ? stages[(at + 1) % stages.length]
        : e.key === 'ArrowLeft'
          ? stages[(at - 1 + stages.length) % stages.length]
          : e.key === 'Home'
            ? stages[0]
            : e.key === 'End'
              ? stages[stages.length - 1]
              : undefined;
    if (target === undefined) return;
    e.preventDefault();
    setPicked(target);
    document.getElementById(`gateTab-${target}`)?.focus();
  };
  return (
    <>
      <div className="gateTabs" role="tablist" aria-label="Gate stage" onKeyDown={onKeyDown}>
        {nonEmpty.map(([title, stage, opts]) => {
          const selected = stage === active;
          // Both kinds of off count: the ticket switch and the project-wide Settings switch.
          const offCount = opts.filter((o) => o.disabled || o.configDisabled).length;
          return (
            <button
              key={stage}
              type="button"
              role="tab"
              id={`gateTab-${stage}`}
              className="gateTab"
              aria-selected={selected}
              aria-controls="gateTabPanel"
              tabIndex={selected ? 0 : -1}
              onClick={() => setPicked(stage)}
            >
              {title} {opts.length}
              {offCount > 0 ? <span className="gateTabOff">{` · ${offCount} off`}</span> : null}
            </button>
          );
        })}
      </div>
      <div id="gateTabPanel" className="gateGroup" role="tabpanel" aria-labelledby={`gateTab-${active}`}>
        {activeGroup[2].map((o) => (
          <GateRow
            key={`${activeGroup[1]}:${o.name}`}
            stage={activeGroup[1]}
            name={o.name}
            disabled={!!o.disabled}
            configOff={!!o.configDisabled}
          />
        ))}
      </div>
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
  const moreRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open, popRef, moreRef, onToggle);
  const controls = useSlice(selectControls);
  const identity = useSlice(selectIdentity);
  const overlays = useOverlays();
  const paused = !!controls?.paused;
  const onEdit = usePendingAction((requestId) => send.editTicket(requestId));
  // The two tight-tier twins of the inline header icons: same host post, same drawer, only the home moves (T1396).
  const onBoardLink = usePendingAction((requestId) => {
    if (identity?.ticketUrl) send.openTicketLink(identity.ticketUrl, requestId);
  });
  const onPause = usePendingAction((requestId) => send.pauseExecution(requestId));
  const onResume = usePendingAction((requestId) => send.unpauseExecution(requestId));
  const onFollowUp = usePendingAction((requestId) => send.createFollowUpTicket(requestId));
  const onDetach = usePendingAction((requestId) => send.detachSubtask(requestId));
  const onClose = usePendingAction((requestId) => send.closeTicket(requestId));
  const onReopen = usePendingAction((requestId) => send.reopenTicket(requestId));
  const onArchive = usePendingAction((requestId) => send.archiveTicket(requestId));
  return (
    <div className="menuWrap">
      <button
        id="moreBtn"
        ref={moreRef}
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
      <div id="menuPopover" ref={popRef} className={open ? 'popover menuPopover open' : 'popover menuPopover hidden'} role="menu" aria-label="Ticket controls">
        <div className="menuHeading">Ticket</div>
        <button type="button" className="menuButton" data-act="edit-ticket" role="menuitem" onClick={onEdit}>
          <Icon name="pencil" />
          <span>Edit ticket</span>
        </button>
        {/* Tight tier only: the row hides its provider mark, ↗ and ▤ there, so the same two actions live here. */}
        <HideableButton
          off={!identity?.ticketUrl}
          id="menuBoardLink"
          className="menuButton tightOnly"
          data-act="open-ticket-link"
          data-url={identity?.ticketUrl ?? undefined}
          role="menuitem"
          onClick={onBoardLink}
        >
          <Icon name="external-link" />
          <span>Open in provider</span>
        </HideableButton>
        <button
          id="menuTicketData"
          type="button"
          className="menuButton tightOnly"
          data-act="preview-ticket-data"
          role="menuitem"
          onClick={() => flushSync(overlays.openTicketData)}
        >
          <Icon name="file-text" />
          <span>Ticket details</span>
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
          <span>Detach from parent</span>
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
          <span>Close</span>
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
        {/* Archive: same as the sidebar item, no confirmation; `karst.unarchiveTicket` undoes it. */}
        <HideableButton
          off={!controls?.canArchive}
          id="archiveTicket"
          className="menuButton danger"
          data-act="archive-ticket"
          role="menuitem"
          title="Archive ticket, hiding it from the active list"
          onClick={onArchive}
        >
          <Icon name="archive" />
          <span>Archive</span>
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
        <LayoutSetting />
        <div className="menuDivider" />
        <div className="menuHeading">Gates for this ticket</div>
        <div id="menuGates" className="menuGates">
          <Gates open={open} />
        </div>
      </div>
    </div>
  );
});
