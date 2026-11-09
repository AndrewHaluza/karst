import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { effectiveChecks } from '../approaches/checks.js';
import { createArtifactStore, type ArtifactStore, type ArtifactStoreOptions } from '../artifacts/store.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixRoundManifest } from '../store/fixRoundHeads.js';
import { listRecoveryRounds } from '../store/recoveryRoundsRead.js';
import type { OperatorManifestInfo } from '../workflow/review/manifestBlock.js';
import { getTicket } from '../store/tickets.js';
import { makeReviewArtifactsLoader } from '../workflow/review/artifactsLoader.js';

/** Binds the review artifacts loader to the registry, the artifact store root and the live manifest. */
export function makeReviewArtifactsBinding(deps: {
  registry: Store;
  artifactsRoot: string;
  manifest: () => Manifest | undefined;
  fallbackProjectId: () => number | undefined;
  /** The operator manifest file path; null/undefined → the reviewer gets no manifest section. */
  manifestPath?: () => string | null | undefined;
  /** Test seam; defaults to the real git-backed store. */
  createStore?: (opts: ArtifactStoreOptions) => Pick<ArtifactStore, 'listArtifacts' | 'history' | 'show'>;
}) {
  const createStore = deps.createStore ?? createArtifactStore;
  const manifestOf = (id: number): OperatorManifestInfo | null => {
    const path = deps.manifestPath?.();
    if (!path) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return null; // unreadable → no section, the review runs as before
    }
    // The sha the first fix round recorded is the review base; a later difference is a manifest change.
    let base: string | null = null;
    for (const r of listRecoveryRounds(deps.registry, id)) {
      base = fixRoundManifest(deps.registry, r.id)?.sha ?? null;
      if (base !== null) break;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    return { path, content: bytes.toString('utf8'), changed: base !== null && base !== sha };
  };
  return makeReviewArtifactsLoader({
    manifestOf,
    intentOf: (id) => getTicket(deps.registry, id).intent,
    descriptionOf: (id) => getTicket(deps.registry, id).description,
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
