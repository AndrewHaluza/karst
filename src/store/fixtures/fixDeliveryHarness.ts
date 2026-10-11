import { vi } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createTicket, setAgentState, setStageCurrent } from '../tickets.js';
import { upsertProject } from '../projects.js';
import { openRecoveryRound } from '../recoveryRoundsWrite.js';
import type { NudgeHooks } from '../../ui/nudgeQueue.js';
import type { MessageRoute } from '../../workflow/messageDelivery.js';
import type { FixDeliveryHost, TypedSendResult } from '../../extension/ops/fixDeliveryOps.js';

/** Test harness shared by the fix-delivery ops and sweep tests (not production code). */
export interface Harness {
  store: Store;
  projectId: number;
  ticketId: number;
  clock: { ms: number };
  state: {
    route: MessageRoute;
    launchId: string | undefined;
    running: boolean;
    live: boolean;
    graph: boolean;
    sendResult: TypedSendResult;
  };
  sent: { ticketId: number; deliveryId: number; hooks: NudgeHooks }[];
  needsYou: string[];
  host: FixDeliveryHost;
  advance(ms: number): void;
  openRound(): number;
}

export const T_START = Date.parse('2026-01-01T00:00:00.000Z');

export function makeHarness(): Harness {
  const store = openStore(':memory:');
  const projectId = upsertProject(store, { slug: 'p' }).id;
  const ticketId = createTicket(store, { key: 'K-1', title: 't', projectId }).id;
  setStageCurrent(store, ticketId, 'fix');
  const clock = { ms: T_START };
  const state: Harness['state'] = {
    route: 'hook-block',
    launchId: 'L1',
    running: false,
    live: true,
    graph: false,
    sendResult: 'queued',
  };
  const sent: Harness['sent'] = [];
  const needsYou: string[] = [];
  const host: FixDeliveryHost = {
    store,
    now: () => new Date(clock.ms).toISOString(),
    debug: vi.fn(),
    isGraphTicket: () => state.graph,
    isLive: () => state.live,
    routeFor: () => state.route,
    currentLaunchId: () => state.launchId,
    isRunning: () => state.running,
    sendPointer: (id, deliveryId, hooks) => {
      sent.push({ ticketId: id, deliveryId, hooks });
      return state.sendResult;
    },
    needsYou: (_id, reason) => needsYou.push(reason),
  };
  return {
    store,
    projectId,
    ticketId,
    clock,
    state,
    sent,
    needsYou,
    host,
    advance: (ms) => {
      clock.ms += ms;
    },
    openRound: () =>
      openRecoveryRound(store, {
        ticketId,
        sourceStage: 'uat',
        sourceProcessId: 'gates',
        sourceStageRunId: null,
        sourceProcessRunId: null,
        triggerKind: 'gate-failure',
        triggerDetail: 'lint failed',
        maxRounds: 3,
        startedAt: '2026-01-01T00:00:00Z',
      }).id,
  };
}

export { setAgentState };
