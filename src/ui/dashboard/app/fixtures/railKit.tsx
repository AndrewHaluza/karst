/** Shared fixtures and harness for the stage rail and blocked banner tests. */
import { Profiler, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider, usePendingOps } from '../DashboardAppContext.js';
import type { PendingOps } from '../pendingOps.js';
import { BlockedBanner } from '../BlockedBanner.js';
import { Rail } from '../Rail.js';
import { tracePersist } from './persistTrace.js';

export const TICKET = 942017;
export const REPO = 'fixture:/repos/web';

type Seg = DashboardState['rail']['main'][number];
type Retry = NonNullable<Seg['retry']>;
type Needs = NonNullable<Seg['needs']>;

/** One rail segment, pending and unremarkable unless told otherwise. */
export const seg = (stageKey: string, over: Partial<Omit<Seg, 'cell'>> & { cell?: Record<string, unknown> } = {}): Seg => {
  const { cell, ...rest } = over;
  const status = (rest.status ?? 'pending') as Seg['status'];
  return {
    cell: { stageKey, status: status === 'blocked' ? 'running' : status, ...cell },
    status,
    current: false,
    needsUser: false,
    needs: null,
    retry: null,
    ...rest,
  } as unknown as Seg;
};

export const MAIN = ['scope', 'impl', 'uat', 'review', 'ship', 'done'] as const;

/** The main line with `current` running, everything before it passed. */
export const mainLine = (current: (typeof MAIN)[number], over: Record<string, Partial<Omit<Seg, 'cell'>> & { cell?: Record<string, unknown> }> = {}): Seg[] =>
  MAIN.map((k, i) => {
    const at = MAIN.indexOf(current);
    const base = i < at ? { status: 'passed' as const } : i === at ? { status: 'running' as const, current: true } : {};
    return seg(k, { ...base, ...over[k] });
  });

export const needs = (cta: Needs['cta'], over: Partial<Needs> = {}): Needs => ({ detail: 'needs you', action: 'Do it', cta, ...over });

export const retry = (over: Partial<Retry> = {}): Retry => ({ gate: 'uat', spent: 1, cap: 3, live: false, returnsTo: null, ...over });

export interface StateOpts {
  readonly main?: Seg[];
  readonly approach?: DashboardState['approach'];
  readonly presentedStage?: string;
  readonly stageCurrent?: string;
  readonly currentStage?: unknown;
  readonly baselineReview?: unknown;
  readonly prs?: unknown;
  readonly [extra: string]: unknown;
}

export const railState = (opts: StateOpts = {}): DashboardState => {
  const { main, approach, presentedStage, stageCurrent, ...rest } = opts;
  const current = stageCurrent ?? 'impl';
  return {
    ticketId: TICKET,
    stageCurrent: current,
    presentedStage: presentedStage ?? current,
    rail: { main: main ?? mainLine(current as (typeof MAIN)[number]) },
    approach: approach ?? null,
    currentStage: null,
    prs: [],
    ...rest,
  } as unknown as DashboardState;
};

/** A uat ticket whose current stage carries a block. */
export const blockedState = (blocked: Record<string, unknown> | undefined, over: StateOpts = {}): DashboardState =>
  railState({
    stageCurrent: 'uat',
    currentStage: { stageKey: 'uat', status: 'running', blocked },
    ...over,
  });

const SENDERS = ['shipTicket', 'mergePr', 'resolveConflicts', 'stageResume', 'usageLimitPick', 'usageLimitRetry', 'usageLimitDismiss', 'baselineApprove', 'baselineReject'] as const;

export interface RailHarness {
  readonly send: Record<(typeof SENDERS)[number], ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
  /** The selection written with the view state, per change; null = back to following the ticket. */
  readonly selected: Array<string | null>;
  readonly ops: () => PendingOps;
  readonly setState: ReturnType<typeof vi.fn>;
}

const SCAFFOLD =
  '<div class="stepper"><div class="railwrap" id="rail"></div><div id="inside"></div><div class="fault blocked hidden" id="blocked"></div></div>' +
  '<button id="agentButton" type="button">Agent</button><div id="prs"><button class="mgbtn" id="panelMerge" type="button">Merge</button></div>';

const cleanups: Array<() => void> = [];
export const cleanupRail = (): void => {
  for (const fn of cleanups.splice(0)) fn();
};

function OpsProbe({ onOps }: { readonly onOps: (ops: PendingOps) => void }) {
  onOps(usePendingOps());
  return null;
}

export interface MountOpts {
  /** The persisted view state `bridge.getState()` hands back (besides `state`). */
  readonly persisted?: Record<string, unknown>;
  readonly onRender?: () => void;
  readonly children?: ReactNode;
}

/** Mounts the rail and the banner into the scaffold, like the page does through RegionPortal. */
export function mountRail(initial: DashboardState | null, opts: MountOpts = {}): RailHarness {
  document.body.innerHTML = SCAFFOLD;
  let listener: ((message: HostMessage) => void) | null = null;
  const send = Object.fromEntries(SENDERS.map((name) => [name, vi.fn()])) as RailHarness['send'];
  const trace = tracePersist(opts.persisted);
  const setState = trace.setState;
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial, ...opts.persisted } : null),
    setState,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  let ops: PendingOps | null = null;
  const body = (
    <>
      <Rail />
      <BlockedBanner />
      {opts.children}
    </>
  );
  render(
    <DashboardAppProvider bridge={bridge}>
      <OpsProbe onOps={(o) => (ops = o)} />
      {opts.onRender ? (
        <Profiler id="rail" onRender={opts.onRender}>
          {body}
        </Profiler>
      ) : (
        body
      )}
    </DashboardAppProvider>,
  );
  return {
    send,
    get selected() {
      return trace.sel.map((written) => written.sel);
    },
    setState,
    ops: () => ops!,
    emit: (message) => act(() => listener?.(message)),
  };
}

export const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
export const must = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = q<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
export const all = <T extends HTMLElement = HTMLElement>(sel: string): T[] => [...document.querySelectorAll<T>(sel)];
export const segEl = (stage: string): HTMLElement => must(`#rail .seg.stg-${stage}`);
export const pick = (stage: string): HTMLButtonElement => must<HTMLButtonElement>(`#rail .pick[data-stage="${stage}"]`);
export const go = (): HTMLButtonElement => must<HTMLButtonElement>('#rail .seg .go');
