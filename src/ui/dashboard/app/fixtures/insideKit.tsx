/** Shared fixtures and harness for the Inside block tests. */
import { Profiler, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import type { InsideProcessView, InsideStageView } from '../../../../model/inside/types.js';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider, usePendingOps } from '../DashboardAppContext.js';
import type { PendingOps } from '../pendingOps.js';
import type { OpenTerminal, PersistSel } from '../insideSeam.js';
import { Inside } from '../Inside.js';
import { Rail } from '../Rail.js';

export const TICKET = 942017;

const SENDERS = [
  'insideAction',
  'selectGateAttempt',
  'selectFindingsRepo',
  'refreshShipPreview',
  'sendBackToImplement',
  'addressPrFeedback',
  'deliverToPr',
  'sendCiFailure',
  'rebaseOnBase',
  'rerunGate',
] as const;

/** One process row, passed and unremarkable unless told otherwise. */
export const proc = (id: string, over: Record<string, unknown> = {}): InsideProcessView =>
  ({ id, kind: id, label: id[0]!.toUpperCase() + id.slice(1), status: 'pass', ...over }) as unknown as InsideProcessView;

/** One stage view; `processes` empty shows the blurb. */
export const view = (stageKey: string, over: Record<string, unknown> = {}): InsideStageView =>
  ({ stageKey, title: stageKey.toUpperCase(), dot: 'idle', clock: '10:00:00 · 1s · attempt 1', processes: [], blurb: `${stageKey} blurb`, ...over }) as unknown as InsideStageView;

export interface StateOpts {
  readonly stageCurrent?: string;
  readonly presentedStage?: string;
  readonly ship?: Record<string, unknown>;
  readonly shipPreview?: unknown;
  readonly views?: Record<string, InsideStageView>;
  readonly [extra: string]: unknown;
}

/** A snapshot with the given stage views; every other stage is an empty view. */
export const insideState = (opts: StateOpts = {}): DashboardState => {
  const { stageCurrent, presentedStage, ship, shipPreview, views, ...rest } = opts;
  const current = stageCurrent ?? 'impl';
  const all: Record<string, InsideStageView> = {};
  for (const k of ['scope', 'impl', 'uat', 'review', 'ship', 'done']) all[k] = views?.[k] ?? view(k);
  return {
    ticketId: TICKET,
    stageCurrent: current,
    presentedStage: presentedStage ?? current,
    ship: ship ?? { kind: 'none' },
    shipPreview,
    insideViews: all,
    rail: { main: [] },
    approach: null,
    prs: [],
    sendBack: { available: false },
    rerunGate: { available: false },
    prFeedbackFix: { available: false },
    ciFailure: { available: false, repos: [] },
    rebase: { available: false },
    deliver: { available: false, notOnPr: 0, inSandbox: 0 },
    ...rest,
  } as unknown as DashboardState;
};

export interface InsideHarness {
  readonly send: Record<(typeof SENDERS)[number], ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
  /** What React asked the page to persist (`karst:persistSel`), in order. */
  readonly persisted: PersistSel[];
  /** What React asked the page to open as the console (`karst:openTerminal`), in order. */
  readonly terminals: OpenTerminal[];
  /** The stage menu's open state, as told to the page (`karst:stageMenuOpen`). */
  readonly menuOpen: boolean[];
  readonly ops: () => PendingOps;
}

const SCAFFOLD = '<div class="stepper"><div class="railwrap" id="rail"></div><div id="inside"></div></div>';

const cleanups: Array<() => void> = [];
export const cleanupInside = (): void => {
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
  readonly withRail?: boolean;
  readonly children?: ReactNode;
}

const listen = <T,>(name: string, into: T[]): void => {
  const record = (e: Event): void => {
    into.push((e as CustomEvent<T>).detail);
  };
  window.addEventListener(name, record);
  cleanups.push(() => window.removeEventListener(name, record));
};

/** Mounts the Inside block (and, optionally, the rail) into the scaffold, like the page does through RegionPortal. */
export function mountInside(initial: DashboardState | null, opts: MountOpts = {}): InsideHarness {
  document.body.innerHTML = SCAFFOLD;
  let listener: ((message: HostMessage) => void) | null = null;
  const send = Object.fromEntries(SENDERS.map((name) => [name, vi.fn()])) as InsideHarness['send'];
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial, ...opts.persisted } : opts.persisted ? { ...opts.persisted } : null),
    setState: vi.fn(),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const persisted: PersistSel[] = [];
  const terminals: OpenTerminal[] = [];
  const menuOpen: boolean[] = [];
  listen('karst:persistSel', persisted);
  listen('karst:openTerminal', terminals);
  listen('karst:stageMenuOpen', menuOpen);
  let ops: PendingOps | null = null;
  const body = (
    <>
      <Inside />
      {opts.withRail ? <Rail /> : null}
      {opts.children}
    </>
  );
  render(
    <DashboardAppProvider bridge={bridge}>
      <OpsProbe onOps={(o) => (ops = o)} />
      {opts.onRender ? (
        <Profiler id="inside" onRender={opts.onRender}>
          {body}
        </Profiler>
      ) : (
        body
      )}
    </DashboardAppProvider>,
  );
  return { send, persisted, terminals, menuOpen, ops: () => ops!, emit: (message) => act(() => listener?.(message)) };
}

export const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
export const must = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = q<T>(sel, root);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
export const all = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
export const text = (el: Element | null): string => el?.textContent ?? '';
