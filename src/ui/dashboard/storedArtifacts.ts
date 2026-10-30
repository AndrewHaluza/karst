import type { ArtifactStore, RevisionInfo } from '../../artifacts/store.js';
import { semanticKind, stageOfKind, type ArtifactKind, type ArtifactStage } from '../../model/artifacts.js';

/**
 * The dashboard's Artifacts view model: what the T2 store holds for one ticket,
 * grouped kind → approach. Pure over a read-only store slice; the extension
 * binds the real store, tests pass a fake.
 */

export const UNKNOWN_LABEL = 'unknown';

/** A captured file whose stage no rule resolves; the index shows it last, under its own group. */
export const UNASSIGNED = 'unassigned';
export type StoredStage = ArtifactStage | typeof UNASSIGNED;

const STAGES: readonly ArtifactStage[] = ['impl', 'uat', 'review', 'ship'];
const asStage = (v: string | undefined): ArtifactStage | null => (STAGES as readonly string[]).includes(v ?? '') ? (v as ArtifactStage) : null;

/**
 * The stage a captured file belongs to: the newest revision's Karst-Stage, else the stage its approach is bound to,
 * else the stage of its Karst-Kind, else Unassigned. Files captured from the graph (source=graph) are Implement.
 */
export function resolveStage(trailers: Record<string, string>, approachStage: (approach: string) => ArtifactStage | null): StoredStage {
  const own = asStage(trailers.stage);
  if (own) return own;
  if (trailers.source === 'graph') return 'impl';
  const bound = trailers.approach ? approachStage(trailers.approach) : null;
  if (bound) return bound;
  const kind = semanticKind(trailers.kind);
  return kind ? stageOfKind(kind) : UNASSIGNED;
}

export interface StoredArtifactRow {
  /** `<repo>/<relPath>` — the store key every action carries back. */
  path: string;
  repo: string;
  relPath: string;
  kind: string;
  /** The semantic artifact this file folds into (same Karst-Kind), or null for an ordinary index row. */
  artifactKind: ArtifactKind | null;
  stage: StoredStage;
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
  approachStage: (approach: string) => ArtifactStage | null = () => null,
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
      artifactKind: semanticKind(latest?.trailers.kind),
      stage: resolveStage(latest?.trailers ?? {}, approachStage),
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
