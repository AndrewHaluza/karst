import type { DoctorCheck } from './types.js';

/** Stages where an agent or gate is expected to be doing work. */
const ACTIVE_STAGES: ReadonlySet<string> = new Set(['impl', 'fix', 'uat', 'review']);

const STUCK_NEXT_STEP = 'Open the ticket in the dashboard and resume or reset the stage';

export interface StuckTicket {
  id: number;
  key: string;
  stage: string | null;
  updatedAtMs: number;
  archived: boolean;
  paused: boolean;
  hasLiveSession: boolean;
  hasRunningGate: boolean;
  awaitingMerge: boolean;
  needsHumanRebase: boolean;
  hasOpenBlockingSubtask: boolean;
}

export interface StuckProbes {
  nowMs: number;
  thresholdMs: number;
  tickets: StuckTicket[];
}

/**
 * A ticket is stuck when it sits in an active stage, is neither archived nor
 * paused, has no live session or running gate, has been idle longer than the
 * threshold, and is not legitimately waiting (landing, human rebase, or an
 * open blocking subtask). Pure: reads only the injected probes.
 */
function isStuck(t: StuckTicket, p: StuckProbes): boolean {
  if (t.stage === null || !ACTIVE_STAGES.has(t.stage)) return false;
  if (t.archived || t.paused) return false;
  if (t.hasLiveSession || t.hasRunningGate) return false;
  if (t.awaitingMerge || t.needsHumanRebase || t.hasOpenBlockingSubtask) return false;
  return p.nowMs - t.updatedAtMs > p.thresholdMs;
}

function stuckCheck(t: StuckTicket, p: StuckProbes): DoctorCheck {
  const idleMin = Math.floor((p.nowMs - t.updatedAtMs) / 60_000);
  return {
    id: `state.stuck.${t.key}`,
    area: 'state',
    status: 'warn',
    detail: `${t.key} has been idle in ${t.stage} for ${idleMin} min with no live session or running gate`,
    fix: {
      tier: 'report',
      summary: `${t.key} looks stuck in ${t.stage}`,
      nextStep: STUCK_NEXT_STEP,
    },
  };
}

export function checkStuckTickets(p: StuckProbes): DoctorCheck[] {
  const stuck = p.tickets.filter((t) => isStuck(t, p));
  if (stuck.length === 0) {
    return [{ id: 'state.stuck', area: 'state', status: 'ok', detail: 'no stuck tickets' }];
  }
  return stuck.map((t) => stuckCheck(t, p));
}
