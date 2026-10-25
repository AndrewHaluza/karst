/**
 * The dashboard's Worktrees panel (header + body), rendered by React into the page's
 * existing `.panel` container through `RegionPortal`. Same DOM as the vanilla renderer
 * it replaced (`renderWorktrees`, `renderBaseControl`, `renderBasePopover`).
 *
 * View state the vanilla panel kept at module level lives here now: which base forms are
 * open, the rebase switch per repo, and the base-change requests in flight. None of it is
 * persisted (vanilla owns `vscode.setState` until the switch-over slice).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { DashboardWorktreeView } from '../stateTypes.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend, useHostMessage } from './DashboardAppContext.js';
import { useSlice } from './useSlice.js';
import { usePendingAction } from './usePendingAction.js';
import { WorktreeRow } from './WorktreeRow.js';
import './WorktreesPanel.css';

interface WorktreesSlice {
  /** null before the first host snapshot: the panel is empty and the header button untouched. */
  readonly worktrees: readonly DashboardWorktreeView[] | null;
  readonly stats: DashboardSnapshot['worktreeStats'];
}

const selectWorktrees = (snapshot: DashboardSnapshot): WorktreesSlice => ({
  worktrees: snapshot.state?.worktrees ?? null,
  stats: snapshot.worktreeStats,
});

/** A click on these never closes an open base form: its own pill and popover, and the header's popovers. */
const KEEPS_FORM_OPEN = '.wbase-popover, .wbase, #agentButton, #moreBtn, .popover';

function eventWithin(e: Event, selector: string): boolean {
  const target = e.target as Element | null;
  if (target?.closest?.(selector)) return true;
  return e.composedPath().some((node) => node instanceof Element && node.matches(selector));
}

const firstOpen = (open: Record<string, boolean>): string | undefined => Object.keys(open).find((repo) => open[repo]);

export const WorktreesPanel = memo(function WorktreesPanel() {
  const send = useDashboardSend();
  const { worktrees, stats } = useSlice(selectWorktrees);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  // The rebase switch is ON unless the user turned it off (the safe reading of a never-touched switch).
  const [rebase, setRebase] = useState<Record<string, boolean>>({});
  /** requestId -> repo, for the one base-change request in flight per repo. */
  const requests = useRef(new Map<string, string>());

  // Flushed synchronously: the vanilla form opened (and the switch flipped) within the click, and the
  // popover is positioned from the committed DOM.
  const toggleForm = useCallback((repo: string) => flushSync(() => setOpen((o) => ({ ...o, [repo]: !o[repo] }))), []);
  const toggleRebase = useCallback(
    (repo: string) => flushSync(() => setRebase((r) => ({ ...r, [repo]: r[repo] === false }))),
    [],
  );
  const trackRequest = useCallback((requestId: string, repo: string) => {
    requests.current.set(requestId, repo);
  }, []);

  // A base-change SUCCESS closes its own form; a refusal leaves it open with the draft intact
  // (the reason lands through the runtime's error toast).
  useHostMessage((message) => {
    if (message.type !== 'action-result') return;
    const repo = requests.current.get(message.requestId);
    if (repo === undefined) return;
    requests.current.delete(message.requestId);
    if (message.ok === true) setOpen((o) => ({ ...o, [repo]: false }));
  });

  // Escape and an outside click close the open form. The vanilla document delegators skip this
  // subtree (data-react-owned), so the panel closes it itself.
  const anyOpen = firstOpen(open) !== undefined;
  useEffect(() => {
    if (!anyOpen) return undefined;
    const closeFirst = (): void =>
      setOpen((o) => {
        const repo = firstOpen(o);
        return repo === undefined ? o : { ...o, [repo]: false };
      });
    const onKey = (e: KeyboardEvent): void => {
      // The vanilla handler claims Escape (preventDefault) when it closes an overlay: that press is spent.
      if (e.key === 'Escape' && !e.defaultPrevented) closeFirst();
    };
    const onClick = (e: MouseEvent): void => {
      if (!eventWithin(e, KEEPS_FORM_OPEN)) closeFirst();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [anyOpen]);

  const showChanges = usePendingAction(useCallback((requestId: string) => send.showChanges(requestId), [send]));

  return (
    <>
      <div className="phead">
        Worktrees
        <button
          id="wtChanges"
          className="k-iconbtn iconbtn"
          data-act="show-changes"
          type="button"
          aria-label="Show ticket changes"
          title="Show ticket changes"
          disabled={worktrees !== null && worktrees.length === 0}
          onClick={showChanges}
        >
          <svg className="k-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
            <path d="M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
            <path d="M11 6h5a2 2 0 0 1 2 2v8" />
            <path d="M14 9l-3 -3l3 -3" />
            <path d="M13 18h-5a2 2 0 0 1 -2 -2v-8" />
            <path d="M10 15l3 3l-3 3" />
          </svg>
        </button>
      </div>
      <div className="pbody" id="worktrees">
        {worktrees === null ? null : worktrees.length === 0 ? (
          <div className="k-empty">
            <div className="k-empty-title">No worktrees.</div>
          </div>
        ) : (
          worktrees.map((w) => (
            <WorktreeRow
              key={w.repo}
              w={w}
              stats={stats[w.repo]}
              send={send}
              formOpen={open[w.repo] === true}
              rebaseOn={rebase[w.repo] !== false}
              onToggleForm={toggleForm}
              onToggleRebase={toggleRebase}
              onChangeRequested={trackRequest}
            />
          ))
        )}
      </div>
    </>
  );
});
