import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { effectiveChecks } from '../approaches/checks.js';
import { createArtifactStore, type ArtifactStore, type ArtifactStoreOptions } from '../artifacts/store.js';
import { getTicket } from '../store/tickets.js';
import { makeReviewArtifactsLoader } from '../workflow/review/artifactsLoader.js';

/** Binds the review artifacts loader to the registry, the artifact store root and the live manifest. */
export function makeReviewArtifactsBinding(deps: {
  registry: Store;
  artifactsRoot: string;
  manifest: () => Manifest | undefined;
  fallbackProjectId: () => number | undefined;
  /** Test seam; defaults to the real git-backed store. */
  createStore?: (opts: ArtifactStoreOptions) => Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show'>;
}) {
  const createStore = deps.createStore ?? createArtifactStore;
  return makeReviewArtifactsLoader({
    intentOf: (id) => getTicket(deps.registry, id).intent,
    checksOf: (id) => {
      const approachId = getTicket(deps.registry, id).approach;
      const approach = deps.manifest()?.approaches?.find((a) => a.id === approachId);
      return effectiveChecks(approach ?? { id: approachId ?? '' });
    },
    storeFor: (id) => {
      const projectId = getTicket(deps.registry, id).projectId ?? deps.fallbackProjectId();
      return projectId == null ? null : createStore({ artifactsRoot: deps.artifactsRoot, projectId });
    },
  });
}
