/** Shared fixtures and harness for the Pull requests panel tests. */
import { afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider, usePendingOps } from '../DashboardAppContext.js';
import type { PendingOps } from '../pendingOps.js';
import { PrsPanel } from '../PrsPanel.js';

export const REPO = '/repos/web';
export const URL = 'https://github.com/o/web/pull/42';

type Row = DashboardState['prs'][number];
type Check = DashboardState['mergeChecks'][number];

export const pr = (over: Partial<Row> = {}): Row => ({
  repo: REPO,
  repoDisplay: 'web',
  number: 42,
  url: URL,
  status: 'open',
  branches: 'feat/x → main',
  baseRef: 'main',
  opened: 'opened 2 days ago',
  openedTitle: 'opened Aug 11',
  merged: '',
  mergedTitle: '',
  commentsLabel: '',
  comments: [],
  checks: { state: 'none', label: '', title: '', detailsLabel: '', failing: [] },
  mergeBlockLabel: '',
  canMerge: false,
  mergeBlockedReason: 'awaiting review',
  dismissed: false,
  dismissedLabel: '',
  canDismiss: false,
  ...over,
});

export const failing = (...names: Array<[string, string | null]>): Row['checks'] => ({
  state: 'failing',
  label: `${names.length} failing`,
  title: `${names.length} failing`,
  detailsLabel: `${names.length} failing ${names.length === 1 ? 'check' : 'checks'}`,
  failing: names.map(([name, url]) => ({ name, url, conclusion: 'failure' })),
});

export const mc = (over: Partial<Check> = {}): Check => ({
  repo: REPO,
  state: 'conflicted',
  headline: 'conflicted · 2 files · vs main',
  detailsLabel: '2 conflicting files',
  files: ['src/a.ts', 'src/b.ts'],
  reason: '',
  checkedTitle: '',
  ...over,
});

export interface StateOpts {
  readonly mergeChecks?: Check[];
  readonly ci?: { available: boolean; repos: string[] };
  readonly stageCurrent?: string;
}
export const stateWith = (prs: Row[], opts: StateOpts = {}): DashboardState =>
  ({
    ticketId: 1,
    prs,
    mergeChecks: opts.mergeChecks ?? [],
    ciFailure: opts.ci ?? { available: false, repos: [] },
    stageCurrent: opts.stageCurrent ?? 'ship',
  }) as unknown as DashboardState;

type SendName = 'openPr' | 'copyPrUrl' | 'resolveConflicts' | 'mergePr' | 'dismissPr' | 'undismissPr' | 'refreshPrs' | 'sendCiFailure';

export interface Harness {
  readonly send: Record<SendName, ReturnType<typeof vi.fn>>;
  readonly emit: (message: HostMessage) => void;
  /** The in-flight operations the panel shares with the stage rail, the header and the Inside stage menu (merge, ship, CI). */
  readonly ops: () => PendingOps;
}

function OpsProbe({ onOps }: { readonly onOps: (ops: PendingOps) => void }) {
  onOps(usePendingOps());
  return null;
}

const SCAFFOLD =
  '<div class="panel span prpanel"><div class="phead">Pull requests<span class="count" id="prCount"></span><span class="pops" id="prOps"></span></div><div class="pbody" id="prs"></div></div>';

export function mount(initial: DashboardState | null, onRender?: () => void): Harness {
  document.body.innerHTML = SCAFFOLD;
  let listener: ((message: HostMessage) => void) | null = null;
  const send = {
    openPr: vi.fn(),
    copyPrUrl: vi.fn(),
    resolveConflicts: vi.fn(),
    mergePr: vi.fn(),
    dismissPr: vi.fn(),
    undismissPr: vi.fn(),
    refreshPrs: vi.fn(),
    sendCiFailure: vi.fn(),
  };
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
  const panel = <PrsPanel />;
  let ops: PendingOps | null = null;
  render(
    <DashboardAppProvider bridge={bridge}>
      <OpsProbe onOps={(o) => (ops = o)} />
      {onRender ? (
        <Profiler id="prs" onRender={onRender}>
          {panel}
        </Profiler>
      ) : (
        panel
      )}
    </DashboardAppProvider>,
  );
  return { send, ops: () => ops!, emit: (message) => act(() => listener?.(message)) };
}

const cleanups: Array<() => void> = [];
const pending = new Map<string, HTMLButtonElement>();
/** What the runtime double was asked to settle: [requestId, ok, message]. */
export const settled: Array<[string, boolean | null, string | undefined]> = [];

/** Installs the design-system runtime doubles (real pending semantics: aria-busy + disabled + is-pending); call once per test file. */
export function installRuntimeDoubles(): void {
  beforeEach(() => {
    pending.clear();
    settled.length = 0;
    let n = 0;
    Object.assign(globalThis, {
      karstRequestId: () => `req-${++n}`,
      karstIsPending: (el: Element) => [...pending.values()].includes(el as HTMLButtonElement),
      karstBeginPending: (el: HTMLButtonElement, id: string) => {
        pending.set(id, el);
        el.setAttribute('aria-busy', 'true');
        el.disabled = true;
        el.classList.add('is-pending');
      },
      // What the real runtime does to the control on settle: the pending marks come off it.
      karstSettle: (id: string, ok: boolean | null, message?: string) => {
        settled.push([id, ok, message]);
        const el = pending.get(id);
        pending.delete(id);
        if (!el) return;
        el.removeAttribute('aria-busy');
        el.disabled = false;
        el.classList.remove('is-pending');
      },
      karstIcon: (name: string) =>
        `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-icon="${name}"/></svg>`,
    });
  });
  afterEach(() => {
    cleanup();
    for (const fn of cleanups.splice(0)) fn();
    vi.useRealTimers();
  });
}

export const byAct = (name: string, extra = ''): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-act="${name}"]${extra}`)];
export const one = (name: string, extra = ''): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>(`[data-act="${name}"]${extra}`);
  if (!el) throw new Error(`no [data-act="${name}"]${extra}`);
  return el;
};
export const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
export const texts = (sel: string): string[] => [...document.querySelectorAll(sel)].map((e) => e.textContent ?? '');
export const mergeBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.pacts .mgbtn:last-child')!;
export const refreshBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('#prRefresh')!;
