import type { ArtifactStore, RevisionInfo } from '../../artifacts/store.js';

/**
 * The dashboard's Artifacts view model: what the T2 store holds for one ticket,
 * grouped kind → approach. Pure over a read-only store slice; the extension
 * binds the real store, tests pass a fake.
 */

export const UNKNOWN_LABEL = 'unknown';

export interface StoredArtifactRow {
  /** `<repo>/<relPath>` — the store key every action carries back. */
  path: string;
  repo: string;
  relPath: string;
  kind: string;
  approach: string;
  source: string;
  revisions: number;
  lastAt: string;
  latestSha: string;
  /** Newest first, capped at `HISTORY_CAP`; diffs pair adjacent entries. */
  history: Array<Pick<RevisionInfo, 'sha' | 'at'> & { source: string }>;
}

/** Revisions listed per artifact; the store keeps all of them. */
export const HISTORY_CAP = 50;

export interface StoredArtifactGroup {
  kind: string;
  approaches: Array<{ approach: string; rows: StoredArtifactRow[] }>;
}

export interface StoredArtifactsView {
  total: number;
  groups: StoredArtifactGroup[];
  skips: Array<{ path: string; reason: string }>;
  /** Active outputs globs, named by the empty state. */
  globs: string[];
}

type StoreReader = Pick<ArtifactStore, 'listArtifacts' | 'history' | 'listSkips'>;

const byName = (a: string, b: string): number => {
  // `unknown` sorts last so real kinds/approaches lead.
  if (a === UNKNOWN_LABEL || b === UNKNOWN_LABEL) return a === b ? 0 : a === UNKNOWN_LABEL ? 1 : -1;
  return a.localeCompare(b);
};

export async function buildStoredArtifacts(
  store: StoreReader,
  ticketId: number,
  globs: readonly string[],
): Promise<StoredArtifactsView> {
  const [summaries, skips] = await Promise.all([store.listArtifacts(ticketId), store.listSkips(ticketId)]);
  const rows: StoredArtifactRow[] = [];
  for (const s of summaries) {
    const revs = await store.history(ticketId, s.path);
    const latest = revs[0];
    const slash = s.path.indexOf('/');
    rows.push({
      path: s.path,
      repo: slash === -1 ? s.path : s.path.slice(0, slash),
      relPath: slash === -1 ? '' : s.path.slice(slash + 1),
      kind: latest?.trailers.kind || UNKNOWN_LABEL,
      approach: latest?.trailers.approach || UNKNOWN_LABEL,
      source: latest?.trailers.source || UNKNOWN_LABEL,
      revisions: s.revisions,
      lastAt: latest?.at ?? '',
      latestSha: s.latestSha,
      history: revs.slice(0, HISTORY_CAP).map((r) => ({ sha: r.sha, at: r.at, source: r.trailers.source || UNKNOWN_LABEL })),
    });
  }
  const kinds = [...new Set(rows.map((r) => r.kind))].sort(byName);
  const groups = kinds.map((kind) => {
    const inKind = rows.filter((r) => r.kind === kind);
    const approaches = [...new Set(inKind.map((r) => r.approach))].sort(byName);
    return {
      kind,
      approaches: approaches.map((approach) => ({
        approach,
        rows: inKind.filter((r) => r.approach === approach),
      })),
    };
  });
  return {
    total: rows.length,
    groups,
    skips: skips.map((k) => ({ path: k.path, reason: k.reason })),
    globs: [...globs],
  };
}
