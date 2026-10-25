/**
 * The Pull requests panel's in-flight operations, reproducing the three kinds the vanilla panel kept:
 *
 *  - merge (per repo) and the CI-failure send (one flag for every row): the wire message carries no
 *    request id and the host answers with a state push, so they stay pending until the next SETTLING
 *    push (`settlesActions !== false`). The page still owns the shared maps that settle them (the rail
 *    Merge button and the stage menu read the same operations), so the two sides tell each other when
 *    one begins (`prsSeam.ts`) and the page settles the runtime request.
 *  - dismiss / undismiss (per repo) and the refresh: panel-only. Same lifetime, and this hook settles
 *    the runtime request itself on that push (dismiss: true when the PR is still listed, else unknown;
 *    refresh: always true), exactly as the vanilla `resolveDismissOutcome` / refresh settle did.
 *
 * Nothing persists: an id restored from a reload would claim an operation nobody is running.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useHostMessage } from './DashboardAppContext.js';
import { announceBegin, onPagePending } from './prsSeam.js';

export interface Pending {
  /** Repos whose merge is in flight. */
  readonly merge: ReadonlySet<string>;
  /** Repos whose dismiss or undismiss is in flight. */
  readonly dismiss: ReadonlySet<string>;
  readonly refreshing: boolean;
  /** A "Send CI failure" request is in flight (for any row). */
  readonly ci: boolean;
}

const NONE: Pending = { merge: new Set(), dismiss: new Set(), refreshing: false, ci: false };

export interface PrPendingApi {
  beginMerge(repo: string, requestId: string): void;
  beginDismiss(repo: string, requestId: string): void;
  beginRefresh(requestId: string): void;
  beginCi(requestId: string): void;
}

const withRepo = (set: ReadonlySet<string>, repo: string): ReadonlySet<string> => new Set(set).add(repo);

export function usePrPending(): { readonly pending: Pending; readonly api: PrPendingApi } {
  const [pending, setPending] = useState<Pending>(NONE);
  // The ids of the operations this hook settles itself.
  const dismissIds = useRef(new Map<string, string>());
  const refreshId = useRef<string | null>(null);

  // A click begins synchronously, like the vanilla redraw it replaces: the control must read pending before the dialog opens.
  const begin = useCallback((next: (p: Pending) => Pending) => flushSync(() => setPending(next)), []);

  const api = useMemo<PrPendingApi>(
    () => ({
      beginMerge: (repo, requestId) => {
        begin((p) => ({ ...p, merge: withRepo(p.merge, repo) }));
        announceBegin({ kind: 'merge', repo, requestId });
      },
      beginDismiss: (repo, requestId) => {
        dismissIds.current.set(repo, requestId);
        begin((p) => ({ ...p, dismiss: withRepo(p.dismiss, repo) }));
      },
      beginRefresh: (requestId) => {
        refreshId.current = requestId;
        begin((p) => ({ ...p, refreshing: true }));
      },
      beginCi: (requestId) => {
        begin((p) => ({ ...p, ci: true }));
        announceBegin({ kind: 'ci-failure', requestId });
      },
    }),
    [begin],
  );

  // The page's own controls (rail Merge, stage-menu CI) went pending: show the same operation busy here.
  useEffect(
    () =>
      onPagePending((d) =>
        setPending((p) => (d.kind === 'merge' ? { ...p, merge: withRepo(p.merge, d.repo) } : { ...p, ci: true })),
      ),
    [],
  );

  useHostMessage((message) => {
    // A passive push (live clocks, store news) carries no answer about an action.
    if (message.type !== 'state' || message.settlesActions === false) return;
    const runtime = globalThis as unknown as { karstSettle(requestId: string, ok: boolean | null): void };
    const listed = new Set((message.state.prs ?? []).map((p) => p.repo));
    // Unknown, never failed: a cancelled confirmation is not a failure.
    for (const [repo, requestId] of dismissIds.current) runtime.karstSettle(requestId, listed.has(repo) ? true : null);
    dismissIds.current.clear();
    if (refreshId.current !== null) runtime.karstSettle(refreshId.current, true);
    refreshId.current = null;
    setPending(NONE);
  });

  return { pending, api };
}
