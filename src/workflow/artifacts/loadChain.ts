import type { ArtifactStore } from '../../artifacts/store.js';
import type { ChainEntry } from './chain.js';

const CHAIN_KINDS = new Set(['spec', 'plan']);

/** The latest revision of every spec/plan artifact in the ticket store, text loaded. */
export async function loadChainEntries(
  store: Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show'>,
  ticketId: number,
): Promise<ChainEntry[]> {
  const entries: ChainEntry[] = [];
  for (const a of await store.listArtifacts(ticketId)) {
    const kind = (await store.history(ticketId, a.path))[0]?.trailers['kind'];
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
  return entries;
}
