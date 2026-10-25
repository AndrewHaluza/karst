/**
 * The Pull requests panel's controls. Same DOM, classes and wording as the vanilla `mergeButton`,
 * `dismissButton`, `ciLine` button and `mergeLine` button they replaced. A control that can be pending
 * keeps its className whatever it shows: the runtime's `is-pending` class lives on that node, and a
 * rewritten className would wipe it mid-request (transient looks ride `aria-busy` / `data-*`).
 */
import { memo, useCallback, useEffect, useState, type MouseEvent } from 'react';
import type { PrPanelRow } from '../../../model/prPanelView.js';
import { useDashboardSend, usePendingOps } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import type { PrPendingApi } from './usePrPending.js';
import { beginPending, usePendingAction } from './usePendingAction.js';

const SECONDARY = 'k-btn k-btn--secondary k-btn--sm mgbtn';
const PRIMARY = 'k-btn k-btn--primary k-btn--sm mgbtn';

/** How long the optimistic copy confirmation holds. */
const COPIED_MS = 1200;
const COPIED_TEXT = 'Copied ✓';

/** A link that opens a pull request or a check run on the host (the host validates the URL). */
export function OpenLink({ url, title, children }: { readonly url: string; readonly title: string; readonly children: string }) {
  const send = useDashboardSend();
  const post = usePendingAction(useCallback((requestId: string) => send.openPr(url, requestId), [send, url]));
  const onClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      post(e);
    },
    [post],
  );
  return (
    <a href="#" data-act="open-pr" data-url={url} title={title} onClick={onClick}>
      {children}
    </a>
  );
}

/** The PR URL as inline text: clicking copies it. The host does the clipboard write, so the confirmation is optimistic (UI-R15). */
export function CopyUrl({ url }: { readonly url: string }) {
  const send = useDashboardSend();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const onClick = usePendingAction(
    useCallback(
      (requestId: string) => {
        send.copyPrUrl(url, requestId);
        setCopied(true);
      },
      [send, url],
    ),
  );
  return (
    <button
      type="button"
      className="ptitle url-copy"
      data-act="copy-pr-url"
      data-url={url}
      data-copy=""
      data-copied={copied ? '' : undefined}
      title="Copy pull request URL"
      onClick={onClick}
    >
      <span className="u">{copied ? COPIED_TEXT : url}</span>
      <span className="glyph">
        <Icon name="copy" />
      </span>
    </button>
  );
}

/** Hands one repo's conflict to an agent session; settled by the host's `action-result` like any posting control. */
export function ResolveButton({ repo }: { readonly repo: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.resolveConflicts(repo, requestId), [send, repo]));
  return (
    <button type="button" className={SECONDARY} data-act="resolve-conflicts" data-repo={repo} title="Hand this repo's conflict to an agent session" onClick={onClick}>
      Resolve conflicts
    </button>
  );
}

interface Pendable {
  readonly api: PrPendingApi;
  readonly busy: boolean;
}

/**
 * Merging is IRREVERSIBLE, so the click only asks: the host puts a modal in front of the user (which also
 * chooses the strategy) before anything runs. The webview posts only `{type:'merge-pr', repo}` (UI-R37).
 * `.k-btn--primary` is its treatment per UI-R10b. Offered or not is the host's verdict, never this file's.
 */
export const MergeButton = memo(function MergeButton({ p, busy }: { readonly p: PrPanelRow; readonly busy: boolean }) {
  const send = useDashboardSend();
  // Held in the state the stage rail's Merge shares (pendingOps.ts): one operation, one dialog.
  const ops = usePendingOps();
  const repo = p.repo;
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const requestId = beginPending(e);
      if (requestId === null) return;
      ops.beginMerge(repo, requestId);
      send.mergePr(repo);
    },
    [ops, send, repo],
  );
  if (p.status === 'merged') return null;
  // One <button> in every state: the node (and the runtime's is-pending class on it) survives going pending.
  if (busy) {
    return (
      <button type="button" className={PRIMARY} aria-busy="true" disabled title="Confirm the merge in the dialog">
        Merge
      </button>
    );
  }
  if (!p.canMerge) {
    return (
      <button type="button" className={SECONDARY} disabled title={p.mergeBlockedReason}>
        Merge
      </button>
    );
  }
  const num = p.number ? ` #${p.number}` : '';
  return (
    <button type="button" className={PRIMARY} data-act="merge-pr" data-repo={repo} title={`Merge PR${num} into ${p.baseRef || 'its base'} — cannot be undone`} onClick={onClick}>
      Merge
    </button>
  );
});

/**
 * The only way out of a ship stage parked behind a PR that was closed rather than merged. Consequential
 * but reversible (the undo puts the PR straight back in the gate's way), so secondary. Whether it is
 * offered is the host's verdict (`canDismiss`).
 */
export const DismissButton = memo(function DismissButton({ p, api, busy }: Pendable & { readonly p: PrPanelRow }) {
  const send = useDashboardSend();
  const repo = p.repo;
  const undo = p.dismissed;
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const requestId = beginPending(e);
      if (requestId === null) return;
      api.beginDismiss(repo, requestId);
      if (undo) send.undismissPr(repo);
      else send.dismissPr(repo);
    },
    [api, send, repo, undo],
  );
  if (busy) {
    return (
      <button type="button" className={SECONDARY} aria-busy="true" disabled title="Confirm in the dialog">
        {undo ? 'Undo' : 'Dismiss'}
      </button>
    );
  }
  if (undo) {
    return (
      <button type="button" className={SECONDARY} data-act="undismiss-pr" data-repo={repo} title="Wait on this pull request again" onClick={onClick}>
        Undo dismiss
      </button>
    );
  }
  if (!p.canDismiss) return null;
  return (
    <button type="button" className={SECONDARY} data-act="dismiss-pr" data-repo={repo} title="Stop waiting on this pull request — it will never land" onClick={onClick}>
      Dismiss
    </button>
  );
});

/** Sends the failing CI log to the agent: host-confirmed, then a state push. One request in flight for every row. */
export const CiButton = memo(function CiButton({ api, busy }: Pendable) {
  const send = useDashboardSend();
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const requestId = beginPending(e);
      if (requestId === null) return;
      api.beginCi(requestId);
      send.sendCiFailure();
    },
    [api, send],
  );
  return (
    <button
      type="button"
      className={SECONDARY}
      data-act={busy ? undefined : 'send-ci-failure'}
      aria-busy={busy ? 'true' : undefined}
      disabled={busy}
      title={busy ? 'Fetching the failing logs' : 'Send the failing CI log to the agent — UAT and Review will run again'}
      onClick={onClick}
    >
      Send CI failure to agent
    </button>
  );
});

/** Re-probes every PR (gh per PR, a git fetch per repo: seconds), so it shows the click landed and cannot repeat. Live even with zero PRs. */
export const RefreshButton = memo(function RefreshButton({ api, busy }: Pendable) {
  const send = useDashboardSend();
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const requestId = beginPending(e);
      if (requestId === null) return;
      api.beginRefresh(requestId);
      send.refreshPrs();
    },
    [api, send],
  );
  // aria-label and title are the SAME string in both states (UI-R21).
  const name = busy ? 'Re-checking pull requests…' : 'Re-check pull request status and mergeability now';
  return (
    <button
      id="prRefresh"
      type="button"
      className="k-iconbtn iconbtn"
      data-act="refresh-prs"
      aria-label={name}
      title={name}
      aria-busy={busy ? 'true' : undefined}
      disabled={busy}
      onClick={onClick}
    >
      <Icon name="refresh" size={13} />
    </button>
  );
});
