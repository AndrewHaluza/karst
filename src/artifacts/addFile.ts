import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { OutputKind } from '../manifest/types.js';
import type { ArtifactStore } from './store.js';
import { ticketStoreDir } from './store.js';
import { addTracked } from './tracked.js';

export interface AddArtifactInput {
  store: ArtifactStore;
  artifactsRoot: string;
  projectId: number;
  ticketId: number;
  worktrees: ReadonlyArray<{ repo: string; path: string }>;
  /** Absolute, or relative to the first worktree (the agent's cwd is a worktree). */
  path: string;
  kind: OutputKind;
}

export interface AddedArtifact {
  repo: string;
  relPath: string;
  sha: string | null;
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Commit one file as a `source=pushed` revision and add it to the ticket's
 * tracked set. The path argument is untrusted (it can come from an injected
 * agent), so it must realpath INSIDE one of the ticket's own worktrees — which
 * rejects `..` traversal and symlinks that leave the worktree. The store then
 * reads it again via `snapshotBytes` (O_NOFOLLOW, regular files only).
 */
export async function addArtifactFile(input: AddArtifactInput): Promise<AddedArtifact> {
  const { worktrees } = input;
  const base = worktrees[0]?.path;
  const abs = isAbsolute(input.path) ? input.path : base ? join(base, input.path) : input.path;
  const resolved = real(abs);
  if (resolved === undefined) throw new Error(`file not found: ${input.path}`);
  for (const wt of worktrees) {
    const root = real(wt.path);
    if (root === undefined) continue;
    const rel = relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const relPath = rel.split(sep).join('/');
    const sha = await input.store.commitRevision({
      ticketId: input.ticketId,
      repo: wt.repo,
      relPath,
      sourcePath: resolved,
      trailers: { kind: input.kind, source: 'pushed' },
    });
    const skipped = sha === null && (await isSkipped(input, wt.repo, relPath));
    if (skipped) throw new Error(`artifact skipped: ${wt.repo}/${relPath} (see the ticket's skip list)`);
    addTracked(ticketStoreDir(input.artifactsRoot, input.projectId, input.ticketId), {
      repo: wt.repo,
      relPath,
      kind: input.kind,
    });
    return { repo: wt.repo, relPath, sha };
  }
  throw new Error('path must resolve inside one of the ticket worktrees');
}

/** A null sha is either "unchanged" (fine) or a recorded skip (secret, too big, binary…). */
async function isSkipped(input: AddArtifactInput, repo: string, relPath: string): Promise<boolean> {
  const treePath = `${repo}/${relPath}`;
  const skips = await input.store.listSkips(input.ticketId);
  return skips.some((s) => s.path === treePath);
}
