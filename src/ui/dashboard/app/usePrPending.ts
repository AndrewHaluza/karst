/**
 * The Pull requests panel's own in-flight operations:
 *
 *  - dismiss / undismiss (per repo) and the refresh: panel-only. The wire message carries no request id and the
 *    host answers with a state push, so each stays pending until the next SETTLING push (`settlesActions !==
 *    false`), and this hook settles the runtime request itself on that push (dismiss: true when the PR is still
 *    listed, else unknown; refresh: always true), exactly as the vanilla `resolveDismissOutcome` / refresh settle did.
 *
 * Merge and Send CI failure are not here: the panel's Merge is one operation with the stage rail's Merge, and its
 * Send CI failure one with the Inside stage menu's item, both held in `pendingOps.ts` (every end is React). Nothing persists: an id restored from a reload would claim an operation nobody is running.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useHostMessage } from './DashboardAppContext.js';

export interface Pending {
  /** Repos whose dismiss or undismiss is in flight. */
  readonly dismiss: ReadonlySet<string>;
  readonly refreshing: boolean;
}

const NONE: Pending = { dismiss: new Set(), refreshing: false };

export interface PrPendingApi {
  beginDismiss(repo: string, requestId: string): void;
  beginRefresh(requestId: string): void;
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
      beginDismiss: (repo, requestId) => {
        dismissIds.current.set(repo, requestId);
        begin((p) => ({ ...p, dismiss: withRepo(p.dismiss, repo) }));
      },
      beginRefresh: (requestId) => {
        refreshId.current = requestId;
        begin((p) => ({ ...p, refreshing: true }));
      },
    }),
    [begin],
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
