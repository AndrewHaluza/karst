import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { effectiveChecks } from '../approaches/checks.js';
import { createArtifactStore } from '../artifacts/store.js';
import { findTicketById } from '../store/tickets.js';
import { makeReviewArtifactsLoader } from '../workflow/review/artifactsLoader.js';

/** Binds the review artifacts loader to the registry, the artifact store root and the live manifest. */
export function makeReviewArtifactsBinding(deps: {
  registry: Store;
  artifactsRoot: string;
  manifest: () => Manifest | undefined;
  fallbackProjectId: () => number | undefined;
}) {
  return makeReviewArtifactsLoader({
    intentOf: (id) => findTicketById(deps.registry, id)?.intent ?? null,
    checksOf: (id) => {
      const approachId = findTicketById(deps.registry, id)?.approach;
      const approach = deps.manifest()?.approaches?.find((a) => a.id === approachId);
      return effectiveChecks(approach ?? { id: approachId ?? '' });
    },
    storeFor: (id) => {
      const projectId = findTicketById(deps.registry, id)?.projectId ?? deps.fallbackProjectId();
      return projectId == null ? null : createArtifactStore({ artifactsRoot: deps.artifactsRoot, projectId });
    },
  });
}
