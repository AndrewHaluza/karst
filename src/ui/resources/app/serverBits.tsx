/**
 * Pieces the Servers tab's rows share: the status mark (shape AND word, UI-R28 —
 * colour is only a third carrier) and `useVerb`, the one-mutation-per-row hook.
 *
 * A row owns ONE mutation for all of its verbs, so while any verb is pending the
 * whole row's controls are disabled (no Stop racing a Restart on the same server)
 * and only the pressed control shows busy.
 */
import { useState, type ReactNode } from 'react';
import type { ServerStatus } from '../serversState.js';
import { useHostAction } from './useHostAction.js';
import type { HostMutation } from '../../settings/app/useHostMutation.js';

const MARK: Record<ServerStatus, string> = { running: '●', stopped: '○', failed: '✕' };
const LABEL: Record<ServerStatus, string> = { running: 'Running', stopped: 'Stopped', failed: 'Failed' };

export function StatusMark({ status }: { status: ServerStatus }) {
  return (
    <span className={`smark smark-${status}`}>
      <span className="smark-shape" aria-hidden="true">{MARK[status]}</span>
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
  /** Whether the row's other controls must be disabled (R17: disabled ≠ busy). */
  readonly locked: boolean;
}

export function useVerb<V extends string>(
  kind: string,
  post: (requestId: string, verb: V) => void,
): VerbRunner<V> {
  const mutation = useHostAction<[V]>(kind, post);
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
    locked: mutation.disabled,
  };
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
