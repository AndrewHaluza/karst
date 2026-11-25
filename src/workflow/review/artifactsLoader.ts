/**
 * Loads the ticket's intent / spec / plan for the review findings lane from the
 * per-ticket artifact store (async git reads), host-agnostic via injected seams.
 */
import type { ChainEdge } from '../../approaches/checks.js';
import type { ArtifactStore } from '../../artifacts/store.js';
import { readLastAlignmentReport } from '../artifacts/alignmentReport.js';
import { loadChainEntries } from '../artifacts/loadChain.js';
import { buildReviewArtifacts, type ReviewArtifacts, type ReviewAttachment } from './conformance.js';
import type { OperatorManifestInfo } from './manifestBlock.js';
import type { NoChangeClaim } from '../noChangeClaimText.js';

export interface ReviewArtifactsLoaderDeps {
  intentOf: (ticketId: number) => string | null;
  /** The fix agent no-change claim for the review run; null or absent → none. */
  noChangeClaimOf?: (ticketId: number) => NoChangeClaim | null;
  /** The ticket description; the reviewer sees it only when the intent is blank. */
  descriptionOf?: (ticketId: number) => string | null;
  /** The ticket attachments as host paths (@arch:AC-33); absent or empty → no attachment block. */
  attachmentsOf?: (ticketId: number) => readonly ReviewAttachment[];
  /** Edges the ticket's approach verifies itself. */
  checksOf: (ticketId: number) => ReadonlySet<ChainEdge>;
  /** Null when the ticket has no artifact store (no project). */
  /** The operator manifest (outside the git diff); null when none is known. Absent → no manifest section. */
  manifestOf?: (ticketId: number) => Promise<OperatorManifestInfo | null> | OperatorManifestInfo | null;
  storeFor: (ticketId: number) => Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show'> | null;
}

export function makeReviewArtifactsLoader(
  deps: ReviewArtifactsLoaderDeps,
): (ticketId: number) => Promise<ReviewArtifacts | undefined> {
  return async (ticketId) => {
    const store = deps.storeFor(ticketId);
    const entries = store ? await loadChainEntries(store, ticketId) : [];
    const intent = deps.intentOf(ticketId);
    const description = intent?.trim() ? null : (deps.descriptionOf?.(ticketId)?.trim() ?? null);
    const operatorManifest = await deps.manifestOf?.(ticketId);
    const manifestPart = operatorManifest?.changed ? { operatorManifest } : {};
    const claim = deps.noChangeClaimOf?.(ticketId) ?? null;
    const claimPart = claim === null ? {} : { noChangeClaim: claim };
    const attachments = deps.attachmentsOf?.(ticketId) ?? [];
    const attachmentsPart = attachments.length > 0 ? { attachments } : {};
    if (!intent?.trim() && entries.length === 0 && !description) {
      return operatorManifest?.changed || claim !== null || attachments.length > 0
        ? { intent: null, spec: null, plan: null, ...manifestPart, ...claimPart, ...attachmentsPart }
        : undefined;
    }
    const artifacts = buildReviewArtifacts({
      intent,
      entries,
      checks: deps.checksOf(ticketId),
      lastIntentSpecReport: store ? await readLastAlignmentReport(store, ticketId, 'intent-spec') : null,
    });
    return { ...artifacts, ...(description ? { description } : {}), ...manifestPart, ...claimPart, ...attachmentsPart };
  };
}
