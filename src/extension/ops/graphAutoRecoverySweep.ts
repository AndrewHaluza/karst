/**
 * The coordinator sweep's automatic graph-recovery step (vscode-free). It binds
 * the shared recovery dispatch and the project bulletin to the decision logic
 * in `approaches/graph/coordinator/autoRecovery.ts`. It shows no dialogs.
 */

import { autoRecoverBlockedRuns, createAutoRecoveryMemory } from '../../approaches/graph/coordinator/autoRecovery.js';
import type { Store } from '../../store/db.js';
import { postAgentNote } from '../../store/bulletinNotes.js';
import { blockedGraphRunsForAutoRecovery } from '../../store/graph/graphRuns.js';
import { GRAPH_FAILED_BLOCKER } from '../../approaches/graph/coordinator/recovery.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './graphRecoveryDispatch.js';

export interface AutoRecoverySweepHost {
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}

/** Build the sweep step. The refusal memory lives as long as the step. */
export function makeAutoRecoverySweep(
  seams: GraphRecoverySeams,
  host: AutoRecoverySweepHost,
): (store: Store, projectId: number) => Promise<void> {
  const memory = createAutoRecoveryMemory();
  return async (store, projectId) => {
    try {
      await autoRecoverBlockedRuns(
        {
          db: store.db,
          now: () => new Date().toISOString(),
          debug: host.debug,
          recover: async (input) => dispatchGraphRecovery(seams, input),
          onStopped: ({ ticketId }, note) => {
            const block = stageBlock(store, ticketId, 'impl');
            if (block === null || block.kind !== GRAPH_FAILED_BLOCKER) return;
            if (block.reason.includes(note)) return;
            parkGateStage(store, {
              ticketId,
              stageKey: 'impl',
              kind: GRAPH_FAILED_BLOCKER,
              reason: `${block.reason} — ${note}`,
              runAt: new Date().toISOString(),
              gates: [],
            });
          },
          postNote: (note) =>
            void postAgentNote(store, {
              projectId,
              fromTicketId: note.ticketId,
              title: note.title,
              body: note.body,
            }),
        },
        memory,
        blockedGraphRunsForAutoRecovery(store.db, projectId),
      );
    } catch (err) {
      host.logError('karst: graph automatic recovery failed', err);
    }
  };
}
