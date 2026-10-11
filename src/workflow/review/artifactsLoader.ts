/**
 * Loads the ticket's intent / spec / plan for the review findings lane from the
 * per-ticket artifact store (async git reads), host-agnostic via injected seams.
 */
import type { ChainEdge } from '../../approaches/checks.js';
import type { ArtifactStore } from '../../artifacts/store.js';
import { readLastAlignmentReport } from '../artifacts/alignmentReport.js';
import type { ChainEntry } from '../artifacts/chain.js';
import { buildReviewArtifacts, type ReviewArtifacts } from './conformance.js';

export interface ReviewArtifactsLoaderDeps {
  intentOf: (ticketId: number) => string | null;
  /** Edges the ticket's approach verifies itself. */
  checksOf: (ticketId: number) => ReadonlySet<ChainEdge>;
  /** Null when the ticket has no artifact store (no project). */
  storeFor: (ticketId: number) => Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show'> | null;
}

const CHAIN_KINDS = new Set(['spec', 'plan']);

export function makeReviewArtifactsLoader(
  deps: ReviewArtifactsLoaderDeps,
): (ticketId: number) => Promise<ReviewArtifacts | undefined> {
  return async (ticketId) => {
    const store = deps.storeFor(ticketId);
    const entries: ChainEntry[] = [];
    if (store) {
      for (const a of await store.listArtifacts(ticketId)) {
        const latest = (await store.history(ticketId, a.path)).at(-1);
        const kind = latest?.trailers['kind'];
        if (!kind || !CHAIN_KINDS.has(kind)) continue;
        const slash = a.path.indexOf('/');
        entries.push({
          repo: slash < 0 ? '' : a.path.slice(0, slash),
          relPath: slash < 0 ? a.path : a.path.slice(slash + 1),
          sha: a.latestSha,
          kind,
          text: (await store.show(ticketId, a.latestSha, a.path)).toString('utf8'),
        });
      }
    }
    const intent = deps.intentOf(ticketId);
    if (!intent?.trim() && entries.length === 0) return undefined;
    const artifacts = buildReviewArtifacts({
      intent,
      entries,
      checks: deps.checksOf(ticketId),
      lastIntentSpecReport: store ? await readLastAlignmentReport(store, ticketId, 'intent-spec') : null,
    });
    return artifacts;
  };
}
