import { relative, basename } from 'node:path';
import type { WorktreePathDisplay } from '../manifest/types.js';

/**
 * Optional worktree-path rendering context (from the manifest + workspace root).
 * When `display` is 'relative', a worktree's repo path renders relative to the
 * project root (e.g. `./tatto-timer`) instead of an absolute path. Shared by the
 * dashboard and the sidebar so both surfaces render worktree paths identically.
 */
export interface PathContext {
  display: WorktreePathDisplay;
  projectRoot: string;
}

/**
 * Render a repo path for display. In relative mode, express it relative to the
 * project root:
 *  - repo IS the workspace root  → `./<name>`  (the common single-repo case)
 *  - repo nested under the root  → `./sub/dir`
 *  - repo is a sibling/elsewhere → `../name` (node's `relative` prefixes `../`)
 */
export function repoDisplayPath(repo: string, ctx?: PathContext): string {
  if (!ctx || ctx.display !== 'relative') return repo;
  const rel = relative(ctx.projectRoot, repo);
  if (rel === '') return `./${basename(repo)}`; // repo IS the workspace root
  return rel.startsWith('..') ? rel : `./${rel}`;
}
