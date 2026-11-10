/**
 * The dashboard runtime strip (`data-region="runtime"`): the agent and the sandbox it runs in, as one full-width bar
 * directly under the ticket head. Left to right: the agent dropdown (core, state word, model, effort; opens the staged
 * agent picker), a separator, the sandbox dropdown (backend and what it isolates; opens "Sandbox details"), and the
 * right-aligned actions (Sync, Diff, the "more" menu). An attached note row carries the carry offer or the fallback
 * reason. It is shown for host tickets too. At most one popover is open; Esc and an outside click close it, and Esc
 * returns focus to the trigger. The "more" menu is a roving-focus menu (UI-R54). Remove posts at once: the host's own
 * modal is the only confirm (UI-R33).
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DashboardSandboxView } from '../sandboxView.js';
import { agentName, RuntimeIcon } from './AgentIcon.js';
import { AgentSwitchForm } from './AgentSwitchForm.js';
import { useDashboardSend, useDashboardState } from './DashboardAppContext.js';
import { selectAgent } from './headerSlices.js';
import { Icon } from './Icon.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';
import './RuntimeStrip.css';

type Which = 'agent' | 'sandbox' | 'more';

const LOCKED_TITLE = 'Cannot switch while a fix recovery is running';
const CARRY_TEXT = 'Host branch was rewritten — sync refused. Sandbox commits are safe.';

const BACKEND_NAME: Record<DashboardSandboxView['backend'], string> = { docker: 'Docker', sbx: 'sbx', host: 'Host' };
const WORKSPACE_TEXT: Record<DashboardSandboxView['workspace'], string> = { clone: 'Isolated git clone', worktree: 'Host git worktree' };

/** The network fact as a short phrase: an allowlist (sbx policy or docker proxy) reads "Allowlist proxy". */
function networkText(network: string): string {
  if (network.includes('allowlist')) return 'Allowlist proxy';
  return network.charAt(0).toUpperCase() + network.slice(1);
}

/** The strip's secondary text for the sandbox dropdown: the host protection state, or the workspace and network. */
function secondaryText(sandbox: DashboardSandboxView): { readonly text: string; readonly tone: 'ok' | 'warn' | null } {
  if (sandbox.backend === 'host') {
    const protectedRun = sandbox.hostProtection === 'core-native';
    return { text: `${protectedRun ? 'protected' : 'unprotected'} · worktree`, tone: protectedRun ? 'ok' : 'warn' };
  }
  return { text: `${WORKSPACE_TEXT[sandbox.workspace]} · ${networkText(sandbox.network)}`.toLowerCase(), tone: null };
}

interface MenuItemProps {
  readonly act: string;
  readonly icon: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly danger?: boolean;
  /** Not offered now: stays in the menu, announces `aria-disabled`, and shows `hint` as the reason. */
  readonly disabled?: boolean;
  readonly post: (requestId: string) => void;
  readonly onDone: () => void;
}

function MenuItem({ act, icon, label, hint, danger = false, disabled = false, post, onDone }: MenuItemProps) {
  const onClick = usePendingAction(post);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={danger ? 'rs-item danger' : 'rs-item'}
      data-act={act}
      aria-disabled={disabled ? 'true' : undefined}
      title={disabled && hint ? hint : undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick(e);
        onDone();
      }}
    >
      <Icon name={icon} />
      <span className="rs-item-label">{label}</span>
      {hint ? <span className="rs-item-hint">{hint}</span> : null}
    </button>
  );
}

/** An action button of the strip: icon plus a text label that the narrow tiers hide (the label stays in `aria-label` and `title`). */
function ActionButton(props: {
  readonly act: string;
  readonly icon: string;
  readonly text: string;
  readonly label: string;
  readonly post: (requestId: string) => void;
}) {
  const onClick = usePendingAction(props.post);
  return (
    <button type="button" className="k-btn k-btn--secondary k-btn--sm rs-ab" data-act={props.act} aria-label={props.label} title={props.label} onClick={onClick}>
      <Icon name={props.icon} />
      <span className="rs-ab-text">{props.text}</span>
    </button>
  );
}

function Note({ sandbox, onCarry }: { readonly sandbox: DashboardSandboxView; readonly onCarry: (requestId: string) => void }) {
  const carry = usePendingAction(onCarry);
  if (sandbox.carry) {
    return (
      <div className="rs-note rs-note--warn" data-testid="runtime-note">
        <Icon name="alert-triangle" />
        <span className="rs-note-text">{CARRY_TEXT}</span>
        <button type="button" className="k-btn k-btn--secondary k-btn--sm rs-note-btn" data-act="sandbox-carry" onClick={carry}>
          <Icon name="git-merge" />
          <span>Carry commits onto host</span>
        </button>
      </div>
    );
  }
  if (!sandbox.note) return null;
  return (
    <div className="rs-note rs-note--info" data-testid="runtime-note">
      <Icon name="info-circle" />
      <span className="rs-note-text">{sandbox.note}</span>
    </div>
  );
}

function Row({ icon, label, children }: { readonly icon: ReactNode; readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="rs-row">
      <span className="rs-row-ico">{icon}</span>
      <span className="rs-row-k">{label}</span>
      <span className="rs-row-v">{children}</span>
    </div>
  );
}

function SandboxDetails({ sandbox, onSettings }: { readonly sandbox: DashboardSandboxView; readonly onSettings: () => void }) {
  const host = sandbox.backend === 'host';
  const protectedRun = sandbox.hostProtection === 'core-native';
  const protIcon = protectedRun ? 'shield-check' : 'alert-triangle';
  return (
    <>
      <div className="rs-pop-h">
        <Icon name={host ? 'device-desktop' : 'box'} />
        <span>{BACKEND_NAME[sandbox.backend]}</span>
        {host ? (
          <span className={`rs-chip ${protectedRun ? 'ok' : 'warn'}`}>
            <Icon name={protIcon} />
            {protectedRun ? 'protected' : 'unprotected'}
          </span>
        ) : null}
      </div>
      <div className="rs-pop-b">
        <Row icon={<Icon name="git-branch" />} label="Workspace">{WORKSPACE_TEXT[sandbox.workspace]}</Row>
        <Row icon={<Icon name="world" />} label="Network">{networkText(sandbox.network)}</Row>
        <Row icon={<RuntimeIcon kind="agent" provider={sandbox.core} />} label="Core">{agentName(sandbox.core)}</Row>
        {host ? (
          <Row icon={<Icon name={protIcon} />} label="Protection">
            {protectedRun ? 'Core-native OS sandbox' : 'None — tool use is prompted'}
          </Row>
        ) : null}
      </div>
      <div className="rs-pop-f">
        <span className="rs-help">Backend is set per project</span>
        <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="open-settings" onClick={onSettings}>
          <Icon name="settings" />
          <span>Sandbox settings</span>
        </button>
      </div>
    </>
  );
}

/** The enabled menu items of an open "more" menu, in DOM order. */
const menuItems = (menu: HTMLElement | null): HTMLElement[] =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')) : [];

/** ArrowUp / ArrowDown / Home / End move focus between the menu items; the ends wrap for the arrows. */
function onMenuKey(e: ReactKeyboardEvent<HTMLElement>): void {
  const items = menuItems(e.currentTarget);
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? (at + 1) % items.length
    : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
    : e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : -1;
  if (next < 0) return;
  e.preventDefault();
  items[next]!.focus();
}

export const RuntimeStrip = memo(function RuntimeStrip() {
  const send = useDashboardSend();
  const state = useDashboardState();
  const agent = useSlice(selectAgent);
  const sandbox = state?.sandbox ?? null;
  const [open, setOpen] = useState<Which | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggers = { agent: useRef<HTMLButtonElement>(null), sandbox: useRef<HTMLButtonElement>(null), more: useRef<HTMLButtonElement>(null) };

  const toggle = useCallback((which: Which) => setOpen((cur) => (cur === which ? null : which)), []);
  const close = useCallback(() => setOpen(null), []);
  // Close and hand focus back to the trigger that opened the popover (Esc, a picker commit or cancel, a menu pick).
  const closeToTrigger = useCallback((which: Which | null) => {
    setOpen(null);
    if (which) triggers[which].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the trigger refs are stable
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      // The path survives a target the click itself detached (a picker option re-renders its list).
      const path = e.composedPath();
      const keep = path.some((n) => n instanceof Element && n.matches('.rs-pop, .rs-dd, .rs-more > button'));
      if (!keep) close();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open, close]);

  useEffect(() => {
    if (open === 'more') menuItems(menuRef.current)[0]?.focus();
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      closeToTrigger(open);
    }
  };

  if (!agent && !sandbox) return null;
  const session = agent?.session;
  const canSwitch = session ? session.canSwitch : true;
  const agentState = agent?.agentState ?? 'idle';
  const waiting = agentState === 'waiting';
  // A round works the agent, so it reads running; an agent that waits for the user keeps its own word.
  const running = agentState === 'running' || (agent?.autofixRound === true && !waiting);
  // The strip owns the agent state. During an auto-fix round it adds the round as a suffix.
  const baseWord = running ? 'running' : waiting && agent?.autofixRound ? 'waiting' : 'idle';
  const stateWord = agent?.autofixRound ? `${baseWord} · auto-fix` : baseWord;
  const secondary = sandbox ? secondaryText(sandbox) : null;
  const host = sandbox?.backend === 'host';
  const shell = sandbox?.shell ?? { available: false, why: 'No sandbox yet' };

  return (
    <div className="rs-wrap" data-testid="runtime-strip" role="region" aria-label="Runtime" ref={wrapRef} onKeyDown={onKeyDown}>
      <div className={sandbox && (sandbox.carry || sandbox.note) ? 'rs has-note' : 'rs'}>
        {agent && session ? (
          <div className="rs-cell">
            <button
              id="agentButton"
              ref={triggers.agent}
              type="button"
              className="rs-dd"
              aria-haspopup="dialog"
              aria-expanded={open === 'agent' ? 'true' : 'false'}
              disabled={!canSwitch}
              title={canSwitch ? 'Switch the agent core and model' : LOCKED_TITLE}
              onClick={() => toggle('agent')}
            >
              <span className="rs-badge">
                <RuntimeIcon kind="agent" provider={session.provider} />
                <span className={running ? 'rs-dot running' : 'rs-dot idle'} aria-hidden="true" />
              </span>
              <span className="rs-name">{agentName(session.provider)}</span>
              <span className={running ? 'rs-state running' : 'rs-state'}>{stateWord}</span>
              <span className="rs-sub" title={session.modelId ?? undefined}>
                {session.modelLabel}
                {session.effort ? ` · ${session.effort}` : ''}
              </span>
              {canSwitch ? <Icon name="chevron-down" /> : <Icon name="lock" />}
            </button>
            {!canSwitch ? <span className="rs-lock">fix recovery running</span> : null}
            <div id="agentPopover" className={open === 'agent' ? 'rs-pop rs-pop--agent open' : 'rs-pop rs-pop--agent'} role="dialog" aria-label="Switch active agent">
              <AgentSwitchForm agent={agent} open={open === 'agent'} close={() => closeToTrigger('agent')} />
            </div>
          </div>
        ) : null}

        {agent && sandbox ? <span className="rs-vsep" aria-hidden="true" /> : null}

        {sandbox && secondary ? (
          <div className="rs-cell">
            <button
              ref={triggers.sandbox}
              type="button"
              className="rs-dd"
              aria-haspopup="dialog"
              aria-expanded={open === 'sandbox' ? 'true' : 'false'}
              title={`Sandbox details — ${secondary.text}`}
              onClick={() => toggle('sandbox')}
            >
              <Icon name={host ? 'device-desktop' : 'box'} />
              <span className="rs-name">{BACKEND_NAME[sandbox.backend]}</span>
              <span className={secondary.tone ? `rs-sub rs-sub--sandbox rs-sub--${secondary.tone}` : 'rs-sub rs-sub--sandbox'}>{secondary.text}</span>
              <Icon name="chevron-down" />
            </button>
            <div className={open === 'sandbox' ? 'rs-pop rs-pop--sandbox open' : 'rs-pop rs-pop--sandbox'} role="dialog" aria-label="Sandbox details">
              <SandboxDetails sandbox={sandbox} onSettings={() => { send.openSettings(); closeToTrigger('sandbox'); }} />
            </div>
          </div>
        ) : null}

        {sandbox?.actions ? (
          <div className="rs-acts">
            <ActionButton act="sandbox-sync" icon="arrows-exchange" text="Sync" label="Sync sandbox and host branches" post={(id) => send.sandboxSync(id)} />
            <ActionButton act="sandbox-diff" icon="git-compare" text="Diff" label="Show sandbox changes" post={(id) => send.sandboxDiff(id)} />
            <div className="rs-cell rs-more">
              <button
                ref={triggers.more}
                type="button"
                className="k-iconbtn"
                aria-label="More sandbox actions"
                title="More sandbox actions"
                aria-haspopup="menu"
                aria-expanded={open === 'more' ? 'true' : 'false'}
                onClick={() => toggle('more')}
              >
                <Icon name="dots" />
              </button>
              <div ref={menuRef} className={open === 'more' ? 'rs-pop rs-pop--menu open' : 'rs-pop rs-pop--menu'} role="menu" aria-label="Sandbox actions" onKeyDown={onMenuKey}>
                <MenuItem act="sandbox-stash-update" icon="stack-2" label="Stash & update" hint="keeps changes" post={(id) => send.sandboxStashUpdate(id)} onDone={() => closeToTrigger('more')} />
                <MenuItem
                  act="sandbox-shell"
                  icon="terminal-2"
                  label="Open shell in sandbox"
                  hint={shell.available ? undefined : (shell.why ?? undefined)}
                  disabled={!shell.available}
                  post={(id) => send.sandboxShell(id)}
                  onDone={() => closeToTrigger('more')}
                />
                <MenuItem act="sandbox-stop" icon="player-stop" label="Stop sandbox" hint="resumable" post={(id) => send.sandboxStop(id)} onDone={() => closeToTrigger('more')} />
                <div className="rs-divider" role="separator" />
                <MenuItem act="sandbox-remove" icon="trash" label="Remove sandbox" danger post={(id) => send.sandboxRemove(id)} onDone={() => closeToTrigger('more')} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {sandbox ? <Note sandbox={sandbox} onCarry={(id) => send.sandboxCarry(id)} /> : null}
    </div>
  );
});
