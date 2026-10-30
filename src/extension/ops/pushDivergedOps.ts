import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { clearStageBlock, stageBlock } from '../../store/stageBlocks.js';
import { armForcePushLease } from '../../store/worktrees.js';
import { sendBackToImplement } from '../../workflow/sendBack.js';
import { formatId } from '../../model/entityId.js';
import type { Notify } from './notify.js';

export type PushDivergedRequest = 'overwrite' | 'integrate';

export interface PushDivergedDeps {
  store: Store;
  ticketId: number;
  notify: Notify;
  /** Re-run the ship saga (the Confirm ship path) after the block is cleared. */
  runShip: (ticketId: number) => void;
  /** Drive the ticket after it was sent back to Implement. */
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  debug?: (message: string) => void;
}

/** The send-back reason `Integrate` hands the agent. */
export function integrateReason(ref: string): string {
  return `origin/${ref} has commits this branch lacks: merge origin/${ref} into the branch, then mark done.`;
}

/** `<repo>: origin/<ref> is at …` — the first line `divergedReason` wrote. */
function parseHead(reason: string): { repo: string; ref: string } | null {
  const m = /^(.+?): origin\/(\S+) is at /.exec(reason.split('\n')[0] ?? '');
  return m ? { repo: m[1] as string, ref: m[2] as string } : null;
}

/**
 * The two answers to a `push-diverged` ship block (@arch:BLOCKED). Both refuse
 * unless ship is still parked on that block. Overwrite arms the lease for the
 * diverged repo — the push builds it from the origin SHA it probes itself — and
 * re-runs ship; Integrate sends the ticket back to Implement to merge origin.
 */
export function decidePushDiverged(deps: PushDivergedDeps, request: PushDivergedRequest): 'refused' | PushDivergedRequest {
  const { store, ticketId } = deps;
  const debug = deps.debug ?? (() => {});
  const label = formatId('ticket', ticketId);
  const block = getTicket(store, ticketId).stageCurrent === 'ship' ? stageBlock(store, ticketId, 'ship') : undefined;
  const head = block?.kind === 'push-diverged' ? parseHead(block.reason ?? '') : null;
  if (head === null) {
    deps.notify.warn(`${label} is no longer waiting on a diverged push.`);
    debug(`[gate] push diverged ticket ${ticketId}: refused (not parked)`);
    return 'refused';
  }
  if (request === 'overwrite') {
    armForcePushLease(store, ticketId, head.repo);
    clearStageBlock(store, ticketId, 'ship');
    debug(`[gate] push diverged ticket ${ticketId}: overwrite ${head.repo} (lease armed)`);
    deps.runShip(ticketId);
    return 'overwrite';
  }
  sendBackToImplement(store, ticketId, { debug, reason: integrateReason(head.ref) });
  debug(`[gate] push diverged ticket ${ticketId}: sent back to integrate origin/${head.ref}`);
  deps.redrive(ticketId);
  return 'integrate';
}

/** The two dashboard actions, ready to spread into `DashboardActions`. */
export function makePushDivergedActions(deps: PushDivergedDeps): {
  pushDivergedOverwrite: () => void;
  pushDivergedIntegrate: () => void;
} {
  const run = (request: PushDivergedRequest): void => {
    try {
      decidePushDiverged(deps, request);
    } catch (err) {
      deps.notify.warn(`${formatId('ticket', deps.ticketId)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    deps.refresh(deps.ticketId);
  };
  return {
    pushDivergedOverwrite: () => run('overwrite'),
    pushDivergedIntegrate: () => run('integrate'),
  };
}
