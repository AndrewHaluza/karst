import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { effectiveChecks } from '../approaches/checks.js';
import { createArtifactStore, type ArtifactStore, type ArtifactStoreOptions } from '../artifacts/store.js';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fixRoundManifest } from '../store/fixRoundHeads.js';
import { listRecoveryRounds } from '../store/recoveryRoundsRead.js';
import type { OperatorManifestInfo } from '../workflow/review/manifestBlock.js';
import { getTicket } from '../store/tickets.js';
import { makeReviewArtifactsLoader } from '../workflow/review/artifactsLoader.js';

/**
 * The manifest counts as changed when it was modified after the ticket was created (this covers an
 * impl-stage change, which precedes every fix round and would otherwise sit in the round's base sha),
 * or when its sha differs from the sha the first fix round recorded.
 */
function manifestChanged(registry: Store, ticketId: number, sha: string, mtimeMs: number): boolean {
  const row = registry.db.prepare('SELECT created_at FROM tickets WHERE id = ?').get(ticketId) as { created_at: string } | undefined;
  const createdMs = row ? Date.parse(`${row.created_at.replace(' ', 'T')}Z`) : Number.NaN;
  if (Number.isFinite(createdMs) && mtimeMs > createdMs) return true;
  for (const r of listRecoveryRounds(registry, ticketId)) {
    const base = fixRoundManifest(registry, r.id)?.sha ?? null;
    if (base !== null) return base !== sha;
  }
  return false;
}

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
  const manifestOf = async (id: number): Promise<OperatorManifestInfo | null> => {
    const path = deps.manifestPath?.();
    if (!path) return null;
    let bytes: Buffer;
    let mtimeMs: number;
    try {
      [bytes, mtimeMs] = await Promise.all([readFile(path), stat(path).then((s) => s.mtimeMs)]);
    } catch {
      return null; // unreadable → no section, the review runs as before
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    return { path, content: bytes.toString('utf8'), changed: manifestChanged(deps.registry, id, sha, mtimeMs) };
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
