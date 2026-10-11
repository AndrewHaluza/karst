import type { DriveProcessBundle } from '../agent/processAssignment.js';
import { createArtifactStore, type ArtifactStore, type ArtifactStoreOptions } from '../artifacts/store.js';
import type { Manifest } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { postMessage } from '../store/ticketMessages.js';
import { getTicket } from '../store/tickets.js';
import { runAlignment } from '../workflow/artifacts/alignment.js';
import { recordAlignmentOutcome } from '../workflow/artifacts/alignmentRecord.js';
import { createAlignmentTrigger } from '../workflow/artifacts/alignmentTrigger.js';
import { resolveChain } from '../workflow/artifacts/chain.js';
import { loadChainEntries } from '../workflow/artifacts/loadChain.js';

/**
 * Binds the warn-only artifact alignment check to the registry, the per-ticket
 * artifact store and the `review` process assignment (model/effort/adapter; its
 * custom instructions are NOT applied). Fed by the capture service's revisions.
 */
export function makeAlignmentTrigger(deps: {
  registry: Store;
  artifactsRoot: string;
  manifest: () => Manifest | undefined;
  fallbackProjectId: () => number | undefined;
  /** The `review` process bundle for a ticket; null when that role is disabled. */
  reviewProcess: (ticketId: number) => DriveProcessBundle | null;
  debug: (message: string) => void;
  /** Test seam; defaults to the real git-backed store. */
  createStore?: (opts: ArtifactStoreOptions) => Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show' | 'commitRevision'>;
}) {
  const createStore = deps.createStore ?? createArtifactStore;
  const storeFor = (ticketId: number) => {
    const projectId = getTicket(deps.registry, ticketId).projectId ?? deps.fallbackProjectId();
    if (projectId == null) throw new Error(`ticket ${ticketId} has no project — no artifact store`);
    return { store: createStore({ artifactsRoot: deps.artifactsRoot, projectId }), projectId };
  };
  return createAlignmentTrigger({
    debug: deps.debug,
    loadChain: async (ticketId) =>
      resolveChain({
        intent: getTicket(deps.registry, ticketId).intent,
        entries: await loadChainEntries(storeFor(ticketId).store, ticketId),
      }),
    approachFor: (ticketId) => {
      const approachId = getTicket(deps.registry, ticketId).approach;
      return deps.manifest()?.approaches?.find((a) => a.id === approachId);
    },
    run: async (input) => {
      const process = deps.reviewProcess(input.ticketId);
      if (process === null) {
        deps.debug(`[alignment] ticket ${input.ticketId}: review process disabled — check skipped`);
        return { findings: [], report: '', failed: true };
      }
      return runAlignment(
        { adapter: process.adapter, model: process.assignment.model, effort: process.assignment.effort, debug: deps.debug },
        input,
      );
    },
    record: (outcome) => {
      if (outcome.report === '') return;
      const { store, projectId } = storeFor(outcome.ticketId);
      return recordAlignmentOutcome(
        {
          store,
          postMessage: ({ toTicketId, body }) =>
            void postMessage(deps.registry, { projectId, fromTicketId: null, toTicketId, kind: 'message', body }),
        },
        outcome,
      );
    },
  });
}
