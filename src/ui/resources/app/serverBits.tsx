/**
 * Pieces the Servers tab's rows share: the status mark (shape AND word, UI-R28 —
 * colour is only a third carrier) and `useVerb`, the one-mutation-per-row hook.
 *
 * A row owns ONE mutation for all of its verbs, so while any verb is pending the
 * whole row's controls are disabled (no Stop racing a Restart on the same server)
 * and only the pressed control shows busy.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ServerStatus } from '../serversState.js';
import { useHostAction } from './useHostAction.js';
import type { HostMutation } from '../../settings/app/useHostMutation.js';

import { SERVER_STATUS_MARK, SERVER_STATUS_WORD } from '../../../model/serverStatusText.js';

const MARK: Record<ServerStatus, string> = SERVER_STATUS_MARK;
const LABEL: Record<ServerStatus, string> = SERVER_STATUS_WORD;

/** How long a copy control reads "Copied" before it returns to its own label (RS-16). */
export const COPIED_MS = 1_500;

/** True while the host holds a verb on the row: `starting` / `stopping`, never a crash. */
export function isTransient(status: ServerStatus): boolean {
  return status === 'starting' || status === 'stopping';
}

export function StatusMark({ status }: { status: ServerStatus }) {
  return (
    <span className={`smark smark-${status}`}>
      <span className={`smark-shape${isTransient(status) ? ' smark-busy' : ''}`} aria-hidden="true">{MARK[status]}</span>
      <span className="smark-word">{LABEL[status]}</span>
    </span>
  );
}

export interface VerbRunner<V extends string> {
  readonly mutation: HostMutation<[V]>;
  /** Run `verb`; a no-op while this row already has one in flight. */
  run(verb: V): void;
  /** True while `verb` itself is the one in flight (drives that button's busy mark). */
  busyOn(verb: V): boolean;
  spinningOn(verb: V): boolean;
  /** The verb this row last ran; stays set after it settles, so a result can be attributed. */
  readonly lastVerb: V | null;
  /** Whether the row's other controls must be disabled (R17: disabled ≠ busy). */
  readonly locked: boolean;
}

export function useVerb<V extends string>(
  kind: string,
  post: (requestId: string, verb: V) => void,
  /** A start may take the row's declared health budget; the request is "unknown" only after it (RS-3). */
  timeoutMs?: number,
): VerbRunner<V> {
  const mutation = useHostAction<[V]>(kind, post, timeoutMs);
  const [activeVerb, setActiveVerb] = useState<V | null>(null);
  return {
    mutation,
    run: (verb) => {
      if (mutation.disabled) return;
      setActiveVerb(verb);
      mutation.trigger(verb);
    },
    busyOn: (verb) => mutation.busy && activeVerb === verb,
    spinningOn: (verb) => mutation.spinning && activeVerb === verb,
    lastVerb: activeVerb,
    locked: mutation.disabled,
  };
}

/**
 * The Copy verb's own feedback: on a SUCCESSFUL copy the control reads "Copied"
 * for a moment and returns to its label, at the same width (UI-R18). No toast
 * (RS-16). `token` (the request id) re-arms the flash for a second copy.
 */
export function useCopied(onSuccess: boolean, token: string | undefined): { readonly copied: boolean } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!onSuccess) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [onSuccess, token]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { copied };
}

/** The visible result of a row's last verb: a failure names why; unknown says so. */
export function VerbNote({ mutation }: { mutation: Pick<HostMutation<never[]>, 'status' | 'error'> }): ReactNode {
  if (mutation.status === 'failure') {
    return <div className="rownote" role="alert">{mutation.error ?? 'That did not complete.'}</div>;
  }
  if (mutation.status === 'unknown') {
    return <div className="rownote" role="alert">No answer from the host yet — this list refreshes when it does.</div>;
  }
  return null;
}
