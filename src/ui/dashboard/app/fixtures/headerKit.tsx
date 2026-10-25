/** Shared fixtures and harness for the header tests: a complete-enough state, the static roots, and the runtime doubles. */
import { afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider, usePendingOps } from '../DashboardAppContext.js';
import type { PendingOps } from '../pendingOps.js';
import { Header } from '../Header.js';

export const headerState = (over: Record<string, unknown> = {}): DashboardState =>
  ({
    ticketId: 1,
    idLabel: 'T7',
    key: 'FEAT-7',
    title: 'Add the thing',
    provider: null,
    priority: null,
    ticketUrl: null,
    origin: null,
    parent: null,
    subtaskParent: null,
    blockers: [],
    canDetachSubtask: false,
    canClose: false,
    canReopen: false,
    paused: false,
    stageCurrent: 'impl',
    currentStage: null,
    ship: { kind: 'none' },
    agentState: 'idle',
    agentSession: { provider: 'claude', providerLabel: 'Claude Code', modelId: 'm1', modelLabel: 'Model One', effort: null, canSwitch: true },
    agentSwitch: {
      cores: [{ id: 'claude', label: 'Claude Code' }],
      models: {},
      modelsByCore: { claude: [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }] },
      recentByCore: {},
      effort: null,
      modelInheritLabel: 'M',
      effortInheritLabel: 'E',
      inheritCore: 'claude',
    },
    capabilityIdentity: { implementation: { provider: 'claude', model: 'm1' }, uatTester: null, review: null },
    ...over,
  }) as unknown as DashboardState;

export interface HeaderHarness {
  readonly send: Record<string, ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
  /** The in-flight operations the header shares with the stage rail (ship). */
  readonly ops: () => PendingOps;
}

function OpsProbe({ onOps }: { readonly onOps: (ops: PendingOps) => void }) {
  onOps(usePendingOps());
  return null;
}

const SENDERS = [
  'copyTicketKey', 'openTicketLink', 'openDependency', 'detachSubtask', 'closeTicket', 'reopenTicket', 'editTicket',
  'pauseExecution', 'unpauseExecution', 'createFollowUpTicket', 'setDisabledGates', 'toggleBind', 'switchAgent', 'shipTicket',
] as const;

export function mountHeader(initial: DashboardState | null): HeaderHarness {
  document.body.innerHTML = '<div class="dhead"></div><div id="headerMeta" class="headerMeta" hidden></div>';
  let listener: ((message: HostMessage) => void) | null = null;
  const send = Object.fromEntries(SENDERS.map((name) => [name, vi.fn()])) as HeaderHarness['send'];
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => (initial ? { state: initial } : null),
    setState: vi.fn(),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  let ops: PendingOps | null = null;
  render(
    <DashboardAppProvider bridge={bridge}>
      <OpsProbe onOps={(o) => (ops = o)} />
      <Header />
    </DashboardAppProvider>,
  );
  return { send, ops: () => ops!, emit: (message) => act(() => listener?.(message)) };
}

const pending = new Set<Element>();
/** Installs the design-system runtime doubles; call once at the top of a test file. */
export function installHeaderDoubles(): void {
  beforeEach(() => {
    pending.clear();
    let n = 0;
    Object.assign(globalThis, {
      karstRequestId: () => `req-${++n}`,
      karstIsPending: (el: Element) => pending.has(el),
      karstSettle: vi.fn(),
      karstBeginPending: (el: Element) => {
        pending.add(el);
        el.classList.add('is-pending');
      },
      karstIcon: (name: string) =>
        `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-icon="${name}"/></svg>`,
      agentIconHtml: (p: string) => `<span class="agenticon" aria-hidden="true"><svg data-p="${p}"></svg></span>`,
      providerIconHtml: (p: string) => (p === 'clickup' ? '<span class="provicon" aria-hidden="true"><svg></svg></span>' : ''),
      agentLabel: (p: string) => (p === 'claude' ? 'Claude Code' : p),
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (globalThis as { mountAgentPicker?: unknown }).mountAgentPicker;
  });
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
export const has = (sel: string, cls: string): boolean => $(sel).classList.contains(cls);
