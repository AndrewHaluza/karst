import type { ArtifactStore } from '../../artifacts/store.js';
import type { ChainEdge } from '../../approaches/checks.js';

/** What a successful intent→spec alignment run recorded about the artifacts it saw. */
export interface AlignmentReport {
  specFp: string;
  intentFp: string;
  mediumPlus: number;
}

/** Tree path of an edge's alignment report in the ticket artifact store. */
export function alignmentReportPath(edge: ChainEdge): string {
  return `_karst/alignment/${edge}.md`;
}

/**
 * Trailer keys are `\w+` (the store's trailer reader does not accept hyphens):
 * `specfp`, `intentfp`, `mediumplus`.
 */

/**
 * The newest (`history` is newest-first) alignment report's fingerprints, from the report revision's commit
 * trailers (durable across reloads). Null when no report exists or its trailers
 * are incomplete — "not verified", the safe direction; never throws.
 */
export async function readLastAlignmentReport(
  store: Pick<ArtifactStore, 'history'>,
  ticketId: number,
  edge: ChainEdge,
): Promise<AlignmentReport | null> {
  const revisions = await store.history(ticketId, alignmentReportPath(edge));
  const t = revisions[0]?.trailers;
  const mediumPlus = Number(t?.['mediumplus']);
  if (!t || !t['specfp'] || !t['intentfp'] || !Number.isInteger(mediumPlus)) return null;
  return { specFp: t['specfp'], intentFp: t['intentfp'], mediumPlus };
}
