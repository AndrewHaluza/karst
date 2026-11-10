/**
 * The dashboard's Worktrees panel (header + body), rendered by React into the page's
 * existing `.panel` container through `RegionPortal`. Same DOM as the vanilla renderer
 * it replaced (`renderWorktrees`, `renderBaseControl`, `renderBasePopover`).
 *
 * View state the vanilla panel kept at module level lives here now: which base forms are
 * open, the rebase switch per repo, and the base-change requests in flight. None of it is
 * persisted.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { DashboardWorktreeView } from '../stateTypes.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend, useHostMessage } from './DashboardAppContext.js';
import { useSlice } from './useSlice.js';
import { usePendingAction } from './usePendingAction.js';
import { CopyBranchButton, WorktreeRow } from './WorktreeRow.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import type { DashboardSender } from './hostBridge.js';
import { Section } from './Section.js';
import './Section.css';
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

/** The branch every worktree shares, or null when they differ (or one has none): the header then shows it once. */
export function sharedBranch(worktrees: readonly DashboardWorktreeView[] | null): string | null {
  if (!worktrees || worktrees.length === 0) return null;
  const first = worktrees[0]!.branch;
  return first && worktrees.every((w) => w.branch === first) ? first : null;
}

function HeaderBranch({ branch, send }: { readonly branch: string; readonly send: DashboardSender }) {
  return (
    <>
      <span className="wsum-br">{branch}</span>
      <CopyBranchButton branch={branch} send={send} />
    </>
  );
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

  // Escape and an outside click close the open form.
  const anyOpen = firstOpen(open) !== undefined;
  useEffect(() => {
    if (!anyOpen) return undefined;
    const closeFirst = (): void =>
      setOpen((o) => {
        const repo = firstOpen(o);
        return repo === undefined ? o : { ...o, [repo]: false };
      });
    const onKey = (e: KeyboardEvent): void => {
      // The overlay stack claims Escape (preventDefault) when it closes an overlay: that press is spent.
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

  const headerBranch = sharedBranch(worktrees);
  const rows = worktrees ?? [];
  return (
    <Section
      title="Worktrees"
      count={rows.length}
      summary={headerBranch ? <HeaderBranch branch={headerBranch} send={send} /> : null}
      summaryTitle={headerBranch ?? undefined}
      summaryMono
      bodyId="worktrees"
      actions={
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
          <Icon name="git-compare" size={13} />
        </button>
      }
    >
      {worktrees === null ? null : worktrees.length === 0 ? (
        <EmptyState icon="folder" heading="No worktrees." sub="Implement creates one per repository in scope." />
      ) : (
        worktrees.map((w) => (
          <WorktreeRow
            key={w.repo}
            w={w}
            stats={stats[w.repo]}
            headerBranch={headerBranch}
            send={send}
            formOpen={open[w.repo] === true}
            rebaseOn={rebase[w.repo] !== false}
            onToggleForm={toggleForm}
            onToggleRebase={toggleRebase}
            onChangeRequested={trackRequest}
          />
        ))
      )}
    </Section>
  );
});
