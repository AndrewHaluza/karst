/**
 * Physical-domain resolution (Slice 3 Task 8).
 *
 * Integration (and scheduling) domains are keyed by the CANONICAL worktree
 * realpath plus the Git common-directory identity — never the manifest
 * repository name, because multiple repository entries may intentionally
 * share one `repoPath`. Two entries sharing a worktree therefore resolve to
 * ONE physical domain whose change sets serialize. `canonicalPath` resolves
 * symlinks, so a worktree reached through a symlink aliases the same domain
 * as its real directory.
 *
 * Host-agnostic: the git common-dir probe is injected (tests fake it; the
 * extension binds `git rev-parse --git-common-dir`).
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPath } from '../../../runtime/pathScope.js';
import { canonicalRepoId } from '../../../runtime/repoId.js';

/** One manifest repository entry of the ticket: its name and worktree path. */
export interface DomainEntry {
  repoName: string;
  worktreePath: string;
}

/** The subset of a manifest repository entry this resolver needs. */
export interface ResolvableRepositoryEntry {
  repoPath: string;
}

/**
 * Resolve the ticket's manifest repository entries to their worktree paths.
 *
 * The `worktrees.repo` column stores the repo PATH (the schema's
 * "worktrees.repo (the repoPath)"), never the manifest NAME — so a manifest
 * name resolves through its own `repoPath` before matching a worktree row.
 * Two entries sharing a `repoPath` (a monorepo with several runnable
 * processes) intentionally resolve to the same worktree. Entries whose
 * repository has no worktree registered for the ticket are omitted.
 *
 * Host-agnostic: takes the manifest's repository map and the ticket's
 * `listWorktreesByTicket` rows; the extension supplies both.
 */
export function resolveRepoWorktrees(
  repositories: Readonly<Record<string, ResolvableRepositoryEntry>>,
  worktrees: readonly { repo: string; path: string }[],
): DomainEntry[] {
  const byRepoPath = new Map(worktrees.map((wt) => [wt.repo, wt.path]));
  return Object.entries(repositories).flatMap(([repoName, def]) => {
    const path = byRepoPath.get(def.repoPath);
    return path ? [{ repoName, worktreePath: path }] : [];
  });
}

/**
 * Index the ticket's resolved entries by the CANONICAL repository id — the one
 * form a graph document can claim (`runtime/repoId.ts`). A manifest key of any
 * casing (`BE`, `DBGW`) is therefore reachable from a node claim; two keys that
 * canonicalize alike are rejected at manifest validation, so first-wins here is
 * unreachable in a valid manifest and merely keeps this total.
 */
export function repoWorktreeIndex(entries: readonly DomainEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    const id = canonicalRepoId(entry.repoName);
    if (!index.has(id)) index.set(id, entry.worktreePath);
  }
  return index;
}

export interface PhysicalDomain {
  /** The durable identity used by leases and serialization. */
  key: string;
  /** Canonical (symlink-resolved) worktree path — the integration target. */
  canonicalWorktree: string;
  /** Git common-directory identity; null when the probe declined. */
  gitCommonDir: string | null;
  /** Manifest repository names aliasing this one domain. */
  repoNames: string[];
}

const DOMAIN_SEPARATOR = '\u0000';

/** The durable domain key: canonical worktree + git common-dir identity. */
export function domainKeyOf(canonicalWorktree: string, gitCommonDir: string | null): string {
  return `${canonicalWorktree}${DOMAIN_SEPARATOR}${gitCommonDir ?? ''}`;
}

/**
 * The Git common-directory identity of a worktree, read from its `.git`
 * file/directory — a tiny local file read, so the probe is synchronous (the
 * domain key is a synchronous identity the leases and serialization share;
 * it never spawns git). A directory `.git` is its own common dir; a linked
 * worktree's `.git` file names `gitdir: <common>/.git/worktrees/<name>`,
 * from which the common dir is the part before `/worktrees/`. A decline
 * (no `.git`) returns null — the worktree still forms a domain, keyed on
 * the canonical path alone.
 */
export function gitCommonDirFromFs(worktreePath: string): string | null {
  try {
    const gitPath = join(worktreePath, '.git');
    const entry = readFileSync(gitPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(entry);
    if (!match) return null;
    const target = match[1]!.trim();
    const worktrees = target.indexOf('/worktrees/');
    const common = worktrees === -1 ? target : target.slice(0, worktrees);
    return canonicalPath(common);
  } catch {
    // A directory `.git` fails readFileSync — it IS the common dir itself.
    // Only a real directory counts: a missing `.git` declines (absence of
    // evidence is not a common dir).
    try {
      const gitPath = join(worktreePath, '.git');
      if (!statSync(gitPath).isDirectory()) return null;
      return canonicalPath(gitPath);
    } catch {
      return null;
    }
  }
}

/**
 * Resolve the ticket's repository entries to physical domains, deduplicated
 * by domain key and sorted by key (deterministic ordering everywhere the
 * module iterates domains).
 */
export function resolvePhysicalDomains(
  entries: readonly DomainEntry[],
  gitCommonDirOf: (cwd: string) => string | null,
): PhysicalDomain[] {
  const byKey = new Map<string, PhysicalDomain>();
  for (const entry of entries) {
    const canonicalWorktree = canonicalPath(entry.worktreePath);
    const key = domainKeyOf(canonicalWorktree, gitCommonDirOf(canonicalWorktree));
    let domain = byKey.get(key);
    if (!domain) {
      domain = {
        key,
        canonicalWorktree,
        gitCommonDir: gitCommonDirOf(canonicalWorktree),
        repoNames: [],
      };
      byKey.set(key, domain);
    }
    domain.repoNames.push(entry.repoName);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
