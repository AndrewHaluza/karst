import type { Store } from './db.js';
import type { MergeHeadFacts } from '../model/inside/deliver.js';
import { listPrsByTicket } from './dashboard.js';
import { listMergeChecksByTicket } from './mergeChecks.js';

/**
 * Per repo: the local merge-check head, the stored PR head and GitHub's merge block (T1143).
 * A repo appears only when it has a clean merge check and an unmerged PR row (the newest wins). A failed read gives an empty map.
 */
export function mergeHeadFactsByRepo(store: Store, ticketId: number): Map<string, MergeHeadFacts> {
  const out = new Map<string, MergeHeadFacts>();
  try {
    const prs = new Map(listPrsByTicket(store, ticketId).filter((p) => p.status === 'open' || p.status === 'draft' || p.status === null).map((p) => [p.repo, p] as const));
    for (const c of listMergeChecksByTicket(store, ticketId)) {
      const pr = prs.get(c.repo);
      if (c.state !== 'clean' || pr === undefined) continue;
      out.set(c.repo, { localHead: c.headSha, prHead: pr.headOid ?? null, mergeBlock: pr.mergeBlock === 'unknown' ? null : pr.mergeBlock });
    }
  } catch {
    out.clear();
  }
  return out;
}
