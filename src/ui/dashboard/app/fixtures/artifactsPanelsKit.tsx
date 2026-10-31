/** Shared fixtures and harness for the Artifacts shelf and Captured artifacts panel tests. */
import { afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import type { HostMessage } from '../../messages.js';
import type { DashboardState } from '../../state.js';
import type { DashboardHostBridge, DashboardSender } from '../hostBridge.js';
import { DashboardAppProvider } from '../DashboardAppContext.js';
import { ArtifactsShelf } from '../ArtifactsShelf.js';
import { tracePersist, type PersistTrace } from './persistTrace.js';
import type { ArtView } from '../overlayStack.js';

type Summary = DashboardState['artifacts'][number];

export const art = (id: string, over: Record<string, unknown> = {}): Summary =>
  ({
    id,
    stage: 'impl',
    kind: id,
    title: id.toUpperCase(),
    scope: null,
    summary: `${id} summary`,
    status: 'info',
    freshness: 'current',
    origin: { kind: 'karst', core: null },
    versionCount: 1,
    currentVersionLabel: 'v1',
    createdAt: null,
    metrics: [],
    gates: [],
    findings: [],
    prs: [],
    commits: [],
    tasks: [],
    resources: [],
    detail: null,
    agentConsole: null,
    ...over,
  }) as unknown as Summary;

export const stored = (groups: Array<[string, number]> = [], total?: number): NonNullable<DashboardState['storedArtifacts']> => ({
  total: total ?? groups.reduce((n, [, rows]) => n + rows, 0),
  globs: [],
  skips: [],
  groups: groups.map(([kind, rows]) => ({
    kind,
    approaches: [{ approach: 'gsd', rows: Array.from({ length: rows }, () => ({}) as never) }],
  })),
});

export const stateWith = (over: Partial<DashboardState>): DashboardState => ({ ticketId: 1, artifacts: [], ...over }) as unknown as DashboardState;

export interface Harness {
  readonly emit: (message: HostMessage) => void;
}

const ROOTS =
  '<div class="panel span hidden" id="artPanel"><div class="phead">Artifacts</div><div class="pbody" id="artifacts"></div></div>';

let trace: PersistTrace = tracePersist();

export function mount(initial: DashboardState | null, onRender?: () => void): Harness {
  document.body.innerHTML = ROOTS;
  trace = tracePersist();
  let listener: ((message: HostMessage) => void) | null = null;
  const bridge: DashboardHostBridge = {
    send: {} as unknown as DashboardSender,
    getState: () => (initial ? { state: initial } : null),
    setState: trace.setState,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const panels = <ArtifactsShelf />;
  render(
    <DashboardAppProvider bridge={bridge}>
      {onRender ? (
        <Profiler id="art" onRender={onRender}>
          {panels}
        </Profiler>
      ) : (
        panels
      )}
    </DashboardAppProvider>,
  );
  return { emit: (message) => act(() => listener?.(message)) };
}

/** The artifact view each navigation has landed on since `mount` (written with the view state). */
export const openedViews = (): Array<ArtView | null> => trace.art.map((written) => written.artView);

afterEach(() => {
  cleanup();
});

export const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
export const text = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
export const isHidden = (sel: string): boolean => q(sel).classList.contains('hidden');
