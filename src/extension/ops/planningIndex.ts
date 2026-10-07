import * as nodeFs from 'node:fs';
import type { Store } from '../../store/db.js';
import { listSessionProposals } from '../../store/planningProposals.js';
import { writeProposalIndex, type ProposalIndexEntry } from '../../planning/proposalIndex.js';

/**
 * Rebuild a session's on-disk proposal index from the store, which is the sole
 * source of truth for every field including each proposal's `uuid`
 * (`source_uuid`, set when the outbox file was ingested or revised). The
 * agent-writable index file is NEVER read back: trusting it for correlation let
 * an edited index resolve a later `draft propose` to the wrong id.
 */
export function refreshProposalIndex(
  store: Store,
  sessionId: number,
  scratch: string,
  opts: { fs?: typeof nodeFs } = {},
): void {
  const entries: ProposalIndexEntry[] = listSessionProposals(store, sessionId).map((p) => ({
    id: p.id,
    uuid: p.sourceUuid,
    title: p.payload.title,
    status: p.status,
    updatedAt: p.updatedAt,
  }));
  writeProposalIndex(scratch, entries, opts.fs ?? nodeFs);
}
