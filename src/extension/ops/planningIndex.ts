import * as nodeFs from 'node:fs';
import type { Store } from '../../store/db.js';
import { listSessionProposals } from '../../store/planningProposals.js';
import { writeOutboxRejection, writeProposalIndex, type ProposalIndexEntry } from '../../planning/proposalIndex.js';

export interface RefreshProposalIndexOpts {
  fs?: typeof nodeFs;
  /** Proposal ids whose async host checks still run; their entries get `checking: true`. */
  checkingIds?: ReadonlySet<number>;
}

/**
 * Rebuild a session's on-disk proposal index from the store, which is the sole
 * source of truth for every field including each proposal's `uuid`
 * (`source_uuid`, set when the outbox file was ingested or revised). The
 * agent-writable index file is NEVER read back: trusting it for correlation let
 * an edited index resolve a later `draft propose` to the wrong id. `warnings`
 * is written only when the draft has some; `checking` only for an id in
 * `checkingIds`.
 */
export function refreshProposalIndex(
  store: Store,
  sessionId: number,
  scratch: string,
  opts: RefreshProposalIndexOpts = {},
): void {
  const entries: ProposalIndexEntry[] = listSessionProposals(store, sessionId).map((p) => ({
    id: p.id,
    uuid: p.sourceUuid,
    title: p.payload.title,
    status: p.status,
    updatedAt: p.updatedAt,
    ...(p.warnings.length > 0 ? { warnings: [...p.warnings] } : {}),
    ...(opts.checkingIds?.has(p.id) ? { checking: true } : {}),
  }));
  writeProposalIndex(scratch, entries, opts.fs ?? nodeFs);
}

/**
 * Tell the planning agent why the host rejected its outbox file `uuid`.
 * `karst draft propose` polls for this file and fails with the reason. Throws
 * on a failed write; the caller decides whether that is fatal.
 */
export function recordOutboxRejection(
  scratch: string,
  uuid: string,
  reason: string,
  nowMs: number,
  opts: { fs?: typeof nodeFs } = {},
): void {
  writeOutboxRejection(scratch, { uuid, reason, rejectedAt: new Date(nowMs).toISOString() }, opts.fs ?? nodeFs);
}
