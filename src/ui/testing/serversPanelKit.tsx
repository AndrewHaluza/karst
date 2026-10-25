/** Shared fixtures and harness for the Servers panel tests. */
import { afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import type { HostMessage } from '../dashboard/messages.js';
import type { DashboardState } from '../dashboard/state.js';
import type { DashboardHostBridge, DashboardSender } from '../dashboard/app/hostBridge.js';
import { DashboardAppProvider } from '../dashboard/app/DashboardAppContext.js';
import { ServersPanel } from '../dashboard/app/ServersPanel.js';

export const srv = (id: number, service: string, over: Record<string, unknown> = {}) => ({
  id,
  ticketId: 1,
  service,
  host: 'localhost',
  port: 3000 + id,
  status: 'running',
  logPath: null,
  ...over,
});
export const shared = (service: string, over: Record<string, unknown> = {}) => ({
  id: 90,
  service,
  status: 'running',
  host: 'localhost',
  port: 5432,
  logPath: '/logs/db.log',
  container: null,
  baseBranch: 'main',
  checkoutPath: '/shared/db',
  sharedWith: 'shared with T9',
  missingReason: null,
  dependents: [],
  ...over,
});
export const stateWith = (servers: unknown[], sharedServers: unknown[] = [], hasRunnableRepos = true): DashboardState =>
  ({ ticketId: 1, servers, sharedServers, hasRunnableRepos }) as unknown as DashboardState;
export const many = (n: number) => Array.from({ length: n }, (_, i) => srv(i + 1, `svc-${i + 1}`));

export interface Harness {
  readonly send: Record<string, ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
}

export function mount(initial: DashboardState | null, persisted: unknown = null, onRender?: () => void): Harness {
  document.body.innerHTML =
    '<div class="panel svpanel"><div class="phead">Servers<span class="count" id="srvCount"></span><span class="pops" id="srvOps"></span></div><div class="pbody" id="servers"></div></div>';
  let listener: ((message: HostMessage) => void) | null = null;
  const send = {
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    startServer: vi.fn(),
    openServer: vi.fn(),
    copyServerUrl: vi.fn(),
    spinServers: vi.fn(),
    restartServers: vi.fn(),
    stopServers: vi.fn(),
    openResources: vi.fn(),
  };
  const bridge: DashboardHostBridge = {
    send: send as unknown as DashboardSender,
    getState: () => persisted ?? (initial ? { state: initial } : null),
    setState: vi.fn(),
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const panel = <ServersPanel />;
  render(
    <DashboardAppProvider bridge={bridge}>
      {onRender ? (
        <Profiler id="sv" onRender={onRender}>
          {panel}
        </Profiler>
      ) : (
        panel
      )}
    </DashboardAppProvider>,
  );
  return { send, emit: (message) => act(() => listener?.(message)) };
}

const pending = new Set<Element>();
/** Installs the design-system runtime doubles; call once at the top of a test file. */
export function installRuntimeDoubles(): void {
  beforeEach(() => {
    pending.clear();
    let n = 0;
    Object.assign(globalThis, {
      karstRequestId: () => `req-${++n}`,
      karstIsPending: (el: Element) => pending.has(el),
      karstBeginPending: (el: Element) => {
        pending.add(el);
        el.setAttribute('aria-busy', 'true');
      },
      karstIcon: (name: string) =>
        `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-icon="${name}"/></svg>`,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
}

export const byAct = (name: string): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(`[data-act="${name}"]`)];
export const one = (name: string, extra = ''): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>(`[data-act="${name}"]${extra}`);
  if (!el) throw new Error(`no [data-act="${name}"]${extra}`);
  return el;
};
export const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
export const filterBox = (): HTMLInputElement => document.querySelector<HTMLInputElement>('#srvFilter')!;
export const names = (): string[] => [...document.querySelectorAll('td.c-name')].map((e) => e.getAttribute('title') ?? e.querySelector('.srvname')!.getAttribute('title')!);

