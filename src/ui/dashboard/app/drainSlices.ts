/**
 * The reload drain as the dashboard reads it (@arch:DRAIN-01). The host builds the live runs and the held
 * ids (`DashboardState.drain`); these selectors only decide what THIS ticket shows.
 */
import type { DashboardDrain } from '../stateTypes.js';
import type { DashboardSnapshot } from './dashboardStore.js';

/** The reason a disabled ship control gives while a reload waits. */
export const DRAIN_HOLD_REASON = 'a reload is waiting for live runs. Cancel the reload to continue';

/** The drain, only when this ticket must show it: it is held, it has a live run, or it sits at ship. */
export const selectDrainBanner = (snapshot: DashboardSnapshot): DashboardDrain | null => {
  const s = snapshot.state;
  const drain = s?.drain;
  if (!s || !drain?.draining) return null;
  const held = drain.held.includes(s.ticketId);
  const live = drain.live.some((r) => r.ticketKey === s.idLabel);
  return held || live || s.stageCurrent === 'ship' ? drain : null;
};

/** True while a reload waits: Confirm ship and Push are refused by the host, so they are disabled. */
export const selectDraining = (snapshot: DashboardSnapshot): boolean => snapshot.state?.drain?.draining === true;

/** The banner sentence. The count is the live-run list length, the number the progress notification shows. */
export function drainBannerText(drain: DashboardDrain): string {
  const n = drain.live.length;
  if (n === 0) return 'Reload starting. Ship and new runs are held.';
  const runs = drain.live.map((r) => `${r.ticketKey} ${r.kind}`).join(', ');
  return `Reload waiting for ${n} live ${n === 1 ? 'run' : 'runs'}: ${runs}. Ship and new runs are held.`;
}
