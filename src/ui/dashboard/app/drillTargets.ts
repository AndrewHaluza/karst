/**
 * What the drill-down surfaces can show for the open ticket, as pure functions of the snapshot: the view pills
 * (Dashboard · Artifacts · Console · Server logs · Env variables), the console streams behind the Console pill, and
 * the label a view has when Back names it. A pill with nothing behind it is not returned (hidden, never disabled).
 */
import type { InsideStatus } from '../../../model/inside/types.js';
import type { DashboardState } from '../state.js';
import type { OverlayView } from './overlayStack.js';

export type PillKey = 'dashboard' | 'artifacts' | 'console' | 'logs' | 'env';

export interface ConsoleStream {
  readonly stage: string;
  readonly processId: string | null;
  readonly label: string;
  readonly status: InsideStatus;
  readonly word: string;
  readonly age: string;
}

export interface ViewPill {
  readonly key: PillKey;
  readonly label: string;
  readonly icon: string;
  /** null = the pill carries no count. */
  readonly count: number | null;
  /** Console only: every stream; one stream opens directly, several open a menu. */
  readonly streams: readonly ConsoleStream[];
}

const STATUS_WORD: Record<InsideStatus, string> = {
  pending: 'Pending',
  run: 'Running',
  wait: 'Waiting',
  pass: 'Passed',
  fail: 'Failed',
  note: 'Note',
  skip: 'Skipped',
};

/** One stream per stage console and per gate-lane AI process console, in stage order. */
export function consoleStreams(views: DashboardState['insideViews'] | undefined): ConsoleStream[] {
  const streams: ConsoleStream[] = [];
  for (const view of Object.values(views ?? {})) {
    if (view.console) {
      const own = view.processes.find((p) => p.id === 'gates');
      const status = own?.status ?? 'pending';
      streams.push({ stage: view.stageKey, processId: null, label: view.title, status, word: own?.statusLabel ?? STATUS_WORD[status], age: own?.time ?? '' });
    }
    for (const p of view.processes) {
      if (!p.console || p.id === 'gates') continue;
      streams.push({ stage: view.stageKey, processId: p.id, label: `${view.title} · ${p.label}`, status: p.status, word: p.statusLabel ?? STATUS_WORD[p.status], age: p.time ?? '' });
    }
  }
  return streams;
}

export function viewPills(state: DashboardState): ViewPill[] {
  const streams = consoleStreams(state.insideViews);
  const artifacts = state.artifacts?.length ?? 0;
  const servers = state.servers?.length ?? 0;
  const pills: ViewPill[] = [{ key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', count: null, streams: [] }];
  if (artifacts > 0) pills.push({ key: 'artifacts', label: 'Artifacts', icon: 'stack-2', count: artifacts, streams: [] });
  if (streams.length > 0) pills.push({ key: 'console', label: 'Console', icon: 'terminal-2', count: streams.length, streams });
  if (servers > 0) pills.push({ key: 'logs', label: 'Server logs', icon: 'server-2', count: servers, streams: [] });
  if (state.envOverrides && servers > 0) pills.push({ key: 'env', label: 'Env variables', icon: 'settings', count: null, streams: [] });
  return pills;
}

/** The pill a view belongs to (the active one carries aria-current). */
export function pillOf(view: OverlayView): PillKey {
  if (view.console) return 'console';
  if (view.logs) return 'logs';
  if (view.env) return 'env';
  return view.art ? 'artifacts' : 'dashboard';
}

/** What Back calls a view: the artifact's title for a detail, else the surface's name. */
export function viewLabel(view: OverlayView, state: DashboardState | null): string {
  if (typeof view.art === 'object' && view.art !== null) {
    const id = view.art.id;
    return state?.artifacts?.find((a) => a.id === id)?.title ?? 'Artifact';
  }
  const label: Record<PillKey, string> = { dashboard: 'Dashboard', artifacts: 'Artifacts', console: 'Console', logs: 'Server logs', env: 'Env variables' };
  return label[pillOf(view)];
}
