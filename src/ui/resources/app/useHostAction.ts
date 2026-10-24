/**
 * One host verb as a React hook: `useHostMutation` (pending on activation, no
 * double-post, unknown on timeout, live-region announcement) plus the wiring that
 * settles it from the reducer's `action-result` receipts. This is the single place
 * the resources app turns a receipt into a mutation outcome, so no component owns
 * async lifecycle state of its own (R11–R15).
 */
import { useEffect, useRef } from 'react';
import { useHostMutation, type HostMutation } from '../../settings/app/useHostMutation.js';
import { useResourcesApp } from './ResourcesAppContext.js';

export function useHostAction<TArgs extends readonly unknown[]>(
  kind: string,
  post: (requestId: string, ...args: TArgs) => void,
): HostMutation<TArgs> {
  const { state } = useResourcesApp();
  const mutation = useHostMutation<TArgs>({ kind, send: post });
  const { requestId, status, settle, reset } = mutation;
  const receipts = state.receipts;
  useEffect(() => {
    if (status !== 'pending' || requestId === undefined) return;
    const receipt = receipts[requestId];
    if (!receipt) return;
    settle({ requestId, result: receipt.ok ? 'success' : 'failure', message: receipt.message });
  }, [receipts, status, requestId, settle]);

  // A request the host never answered stays "unknown" and disabled (R14). The
  // next fresh Servers read is the truthful answer, so it releases the control —
  // but not the read that was already current when the request went unknown.
  const seq = state.serversSeq;
  const unknownAt = useRef<number | null>(null);
  useEffect(() => {
    if (status !== 'unknown') {
      unknownAt.current = null;
      return;
    }
    if (unknownAt.current === null) unknownAt.current = seq;
    else if (seq !== unknownAt.current) reset();
  }, [status, seq, reset]);
  return mutation;
}
