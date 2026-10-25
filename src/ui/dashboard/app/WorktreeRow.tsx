/**
 * One worktree row of the Worktrees panel: the repo label, the base-branch pill and its
 * popover form, the branch with its copy button, the live totals and the row actions.
 * Same DOM, classes, `data-*` hooks and ARIA as the vanilla renderer it replaced.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { DashboardWorktreeView } from '../stateTypes.js';
import type { WorktreeStats } from '../worktreeStats.js';
import type { DashboardSender } from './hostBridge.js';
import { Icon } from './Icon.js';
import { placeBelow } from './placeBelow.js';
import { usePendingAction } from './usePendingAction.js';

/** The popover's fixed width: it must not resize with its content (see WorktreesPanel.css). */
const POPOVER_WIDTH = 280;
/** How long the optimistic copy confirmation holds. */
const COPIED_MS = 1200;

/** Optimistic (UI-R15): the host does the clipboard write and cannot fail in a way the user must act on. */
function CopyBranchButton({ branch, send }: { readonly branch: string; readonly send: DashboardSender }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const onClick = usePendingAction(
    useCallback(
      (requestId: string) => {
        send.copyWorktreeBranch(branch, requestId);
        setCopied(true);
      },
      [send, branch],
    ),
  );
  return (
    <button
      type="button"
      // The flash is a data attribute, never a className change: React rewriting className would wipe
      // the runtime's `is-pending` class while the request is in flight.
      className="k-iconbtn ib t-copy"
      data-copied={copied ? '' : undefined}
      data-act="copy-worktree-branch"
      data-branch={branch}
      data-copy=""
      aria-label={copied ? 'Copied' : 'Copy branch name'}
      title="Copy branch name"
      disabled={copied}
      onClick={onClick}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
}

interface BasePopoverProps {
  readonly w: DashboardWorktreeView;
  readonly rebaseOn: boolean;
  readonly send: DashboardSender;
  readonly popRef: RefObject<HTMLDivElement | null>;
  readonly onToggleForm: (repo: string) => void;
  readonly onToggleRebase: (repo: string) => void;
  readonly onChangeRequested: (requestId: string, repo: string) => void;
}

/** Sits OUTSIDE `.wt` (inside `.wtwrap`) so it overlays content without shifting the row height. */
function BasePopover({ w, rebaseOn, send, popRef, onToggleForm, onToggleRebase, onChangeRequested }: BasePopoverProps) {
  const repo = w.repo;
  const current = w.baseRef || w.baseDefault || '';
  // A mid-typed value lives here, so it survives every push and dies with the form (cancel, Esc, success).
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `wbase-list-${repo}`;
  const submit = usePendingAction(
    useCallback(
      (requestId: string) => {
        send.changeBaseRef(repo, inputRef.current?.value.trim() ?? '', rebaseOn, requestId);
        onChangeRequested(requestId, repo);
      },
      [send, repo, rebaseOn, onChangeRequested],
    ),
  );
  return (
    <div ref={popRef} className="wbase-popover open" data-wbase-popover={repo}>
      <div className="k-field">
        <label htmlFor={`wbaseinput-${repo}`}>New base branch for {w.serviceName || w.repoDisplay || repo}</label>
        <input
          ref={inputRef}
          className="k-input"
          id={`wbaseinput-${repo}`}
          type="text"
          list={listId}
          defaultValue=""
          placeholder={current}
          data-base-input={repo}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <datalist id={listId}>
          {(w.baseCandidates || []).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
      <button
        type="button"
        className="k-switch"
        role="switch"
        aria-checked={rebaseOn}
        data-act="toggle-rebase-switch"
        data-repo={repo}
        onClick={() => onToggleRebase(repo)}
      >
        <span className="k-switch-track" aria-hidden="true" />
        Rebase the branch onto the new base
      </button>
      <div className="k-field-help">
        Rebasing rewrites the ticket branch's commits. Karst arms the force-push automatically at ship time. Turning this
        off only re-targets the pull request — useful when the branch was already cut from the right commit.
      </div>
      <div className="wbaseformacts">
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          data-act="toggle-base-form"
          data-repo={repo}
          onClick={() => onToggleForm(repo)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="k-btn k-btn--primary k-btn--sm"
          data-act="change-base-ref"
          data-repo={repo}
          data-base-current={current}
          // A blank base posts nothing (the host would reject it) and does not go pending.
          onClick={(e) => {
            if (inputRef.current?.value.trim()) submit(e);
          }}
        >
          {rebaseOn && draft.trim() === current ? `Rebase onto ${current}` : 'Change base'}
        </button>
      </div>
    </div>
  );
}

export interface WorktreeRowProps {
  readonly w: DashboardWorktreeView;
  readonly stats: WorktreeStats | undefined;
  readonly send: DashboardSender;
  readonly formOpen: boolean;
  readonly rebaseOn: boolean;
  readonly onToggleForm: (repo: string) => void;
  readonly onToggleRebase: (repo: string) => void;
  readonly onChangeRequested: (requestId: string, repo: string) => void;
}

export function WorktreeRow({ w, stats, send, formOpen, rebaseOn, onToggleForm, onToggleRebase, onChangeRequested }: WorktreeRowProps) {
  const editRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (formOpen && popRef.current && editRef.current) placeBelow(popRef.current, editRef.current, POPOVER_WIDTH);
  }, [formOpen]);

  const openTerminal = usePendingAction(useCallback((requestId: string) => send.openWorktreeTerminal(w.path, requestId), [send, w.path]));
  const openFolder = usePendingAction(useCallback((requestId: string) => send.openWorktreeFolder(w.path, requestId), [send, w.path]));
  const launchExtension = usePendingAction(
    useCallback((requestId: string) => send.launchWorktreeExtension(w.path, requestId), [send, w.path]),
  );

  const current = w.baseRef || w.baseDefault || '';
  const repoLabel = w.serviceName || w.repoDisplay || w.repo;
  const repoTitle = w.serviceName ? w.repoDisplay || w.repo : '';
  return (
    <div className="wtwrap" data-wtwrap={w.repo}>
      <div className="wt">
        <span className="wrepo" title={repoTitle || undefined}>
          {repoLabel}
        </span>
        <span className="wbase">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
            <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
          </svg>
          <span className="wbasebr">{current || '---'}</span>
          <button
            ref={editRef}
            type="button"
            className="wbase-edit k-iconbtn"
            data-act="toggle-base-form"
            data-repo={w.repo}
            aria-label="Change base branch"
            title="Change base branch"
            onClick={() => onToggleForm(w.repo)}
          >
            ✎
          </button>
        </span>
        {w.branch ? (
          <span className="wbranch">
            <span className="wbr">{w.branch}</span>
            <CopyBranchButton branch={w.branch} send={send} />
          </span>
        ) : null}
        {stats ? (
          <span className="wstats">
            <span className="wadd">{`+${stats.additions}`}</span> <span className="wdel">{`−${stats.deletions}`}</span>
          </span>
        ) : null}
        <span className="wsep" />
        <span className="wacts">
          <button
            type="button"
            className="k-iconbtn ib t-open"
            data-act="open-worktree-terminal"
            data-path={w.path}
            aria-label="Open terminal"
            title="Open a terminal in this worktree"
            onClick={openTerminal}
          >
            <Icon name="terminal-2" />
          </button>
          <button
            type="button"
            className="k-iconbtn ib t-copy"
            data-act="open-worktree-folder"
            data-path={w.path}
            aria-label="Reveal in file explorer"
            title="Reveal this worktree in the file explorer"
            onClick={openFolder}
          >
            <Icon name="folder" />
          </button>
          {/* Only karst-extension checkouts can become a dev host (the host probes `launchable`); a foreign repo gets no dead control. */}
          {w.launchable ? (
            <button
              type="button"
              className="k-iconbtn ib t-start"
              data-act="launch-worktree-extension"
              data-path={w.path}
              aria-label="Launch dev host"
              title="Build this worktree and open its extension in a new dev window"
              onClick={launchExtension}
            >
              <Icon name="play-bug" />
            </button>
          ) : null}
        </span>
      </div>
      {formOpen ? (
        <BasePopover
          w={w}
          rebaseOn={rebaseOn}
          send={send}
          popRef={popRef}
          onToggleForm={onToggleForm}
          onToggleRebase={onToggleRebase}
          onChangeRequested={onChangeRequested}
        />
      ) : null}
    </div>
  );
}
