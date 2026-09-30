/**
 * The single owner of async host-mutation lifecycle for the settings React app
 * (NDL-126 §9.2). It carries UI-R11–R15, R17 and R18:
 *
 * - pending is entered locally, synchronously on activation (R11), before any
 *   host result can arrive;
 * - a second activation while pending or unknown is a no-op (R12, R14) — the
 *   guard is a ref, so two synchronous clicks cannot both post;
 * - `disabled` and `busy` are separate values, and a control may be both (R17);
 * - a pending request that outlives `timeoutMs` becomes `unknown`, never a
 *   false `failure` (R14);
 * - terminal results are announced through the app's one live region (R27), and
 *   success is only ever set by an explicit `settle({ result: 'success' })`
 *   (R15).
 *
 * The hook is React-only but host-free: `send` is injected, so it is unit
 * testable without a webview, and the host remains the source of truth (R31).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnnounce } from './primitives/LiveRegion.js';

export type MutationStatus = 'idle' | 'pending' | 'success' | 'failure' | 'unknown';
export type MutationResult = 'success' | 'failure' | 'unknown';

export interface HostMutationOutcome {
  requestId: string;
  result: MutationResult;
  /** Optional host-supplied detail, used in the failure/unknown announcement. */
  message?: string;
}

interface MutationState {
  readonly status: MutationStatus;
  readonly requestId: string | undefined;
  readonly error: string | undefined;
}

export interface UseHostMutationOptions<TArgs extends readonly unknown[]> {
  /** Stable action name, used in announcements. */
  kind: string;
  /** Post the request to the host with a fresh correlation id. */
  send: (requestId: string, ...args: TArgs) => void;
  /** Override the live-region announcer (tests, or a local region). */
  announce?: (message: string) => void;
  /** Pending lifetime before it becomes `unknown`. Defaults to 30s. */
  timeoutMs?: number;
  /** Injectable id generator for deterministic tests. */
  nextRequestId?: () => string;
}

export interface HostMutation<TArgs extends readonly unknown[]> {
  readonly status: MutationStatus;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error: string | undefined;
  readonly requestId: string | undefined;
  trigger: (...args: TArgs) => void;
  settle: (outcome: HostMutationOutcome) => void;
  reset: () => void;
}

const IDLE: MutationState = { status: 'idle', requestId: undefined, error: undefined };
const DEFAULT_TIMEOUT_MS = 30_000;

let requestCounter = 0;
function defaultNextRequestId(): string {
  requestCounter += 1;
  return `m${requestCounter}`;
}

function terminalMessage(kind: string, status: MutationStatus, error: string | undefined): string {
  switch (status) {
    case 'success':
      return `${kind} succeeded.`;
    case 'failure':
      return error ?? `${kind} failed.`;
    case 'unknown':
      return error ?? `${kind}: result unknown.`;
    default:
      return '';
  }
}

export function useHostMutation<TArgs extends readonly unknown[]>({
  kind,
  send,
  announce: announceOverride,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nextRequestId = defaultNextRequestId,
}: UseHostMutationOptions<TArgs>): HostMutation<TArgs> {
  const contextAnnounce = useAnnounce();
  const announce = announceOverride ?? contextAnnounce;

  const [state, setState] = useState<MutationState>(IDLE);
  const stateRef = useRef<MutationState>(IDLE);
  const inFlightRef = useRef(false);

  const apply = useCallback((next: MutationState) => {
    stateRef.current = next;
    inFlightRef.current = next.status === 'pending' || next.status === 'unknown';
    setState(next);
  }, []);

  const trigger = useCallback(
    (...args: TArgs) => {
      if (inFlightRef.current) return;
      const requestId = nextRequestId();
      send(requestId, ...args);
      apply({ status: 'pending', requestId, error: undefined });
    },
    [apply, nextRequestId, send],
  );

  const settle = useCallback(
    (outcome: HostMutationOutcome) => {
      const current = stateRef.current;
      if (current.status !== 'pending' || current.requestId !== outcome.requestId) return;
      apply({
        status: outcome.result,
        requestId: outcome.requestId,
        error: outcome.result === 'failure' ? outcome.message : undefined,
      });
    },
    [apply],
  );

  const reset = useCallback(() => {
    apply(IDLE);
  }, [apply]);

  useEffect(() => {
    if (state.status !== 'pending' || timeoutMs <= 0) return undefined;
    const timer = setTimeout(() => {
      if (stateRef.current.status === 'pending') {
        apply({ ...stateRef.current, status: 'unknown' });
      }
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [state.status, timeoutMs, apply]);

  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status === 'pending' || state.status === 'idle') {
      announcedRef.current = null;
      return;
    }
    const token = `${state.status}:${state.requestId ?? ''}:${state.error ?? ''}`;
    if (announcedRef.current === token) return;
    announcedRef.current = token;
    announce(terminalMessage(kind, state.status, state.error));
  }, [state.status, state.requestId, state.error, announce, kind]);

  const pending = state.status === 'pending';
  const busy = pending;
  const disabled = pending || state.status === 'unknown';

  return useMemo(
    () => ({
      status: state.status,
      pending,
      busy,
      disabled,
      error: state.error,
      requestId: state.requestId,
      trigger,
      settle,
      reset,
    }),
    [state, pending, busy, disabled, trigger, settle, reset],
  );
}