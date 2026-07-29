import type { Manifest } from '../manifest/types.js'

/**
 * Stable `repo_N` aliases for one report.
 *
 * A repository is identified two ways in the store, and the difference is not
 * cosmetic: `tickets.selected_repos`, `servers` and `port_allocations` key it by
 * manifest NAME, while `worktrees`, `prs` and `merge_checks` key it by
 * `repoPath` (entries sharing a path share one worktree — see the monorepo rule
 * in CLAUDE.md). Minting an alias per distinct raw string therefore gave the
 * same repository two aliases and made a two-repository report read as four.
 *
 * So the alias is minted for the NAME only, and a path resolves through the
 * manifest to the names it backs — several for a monorepo, none once the entry
 * has been removed from the manifest.
 */
export interface RepositoryAliases {
  /** Alias for a manifest repository name. Minted on first sight, in call order. */
  readonly byName: (name: string) => string
  /** Aliases of every manifest entry backed by `repoPath`; empty when none is. */
  readonly byPath: (repoPath: string) => readonly string[]
}

export function createRepositoryAliases(manifest: Manifest): RepositoryAliases {
  const minted = new Map<string, string>()
  const byName = (name: string): string => {
    const existing = minted.get(name)
    if (existing) return existing
    const alias = `repo_${minted.size + 1}`
    minted.set(name, alias)
    return alias
  }

  // Disabled entries are included deliberately: a draft repository still owns
  // worktrees and PRs, and a report that cannot name them is the same
  // uncorrelatable report this map exists to prevent.
  const namesByPath = new Map<string, string[]>()
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    const names = namesByPath.get(repository.repoPath) ?? []
    namesByPath.set(repository.repoPath, [...names, name])
  }

  return Object.freeze({
    byName,
    byPath: (repoPath: string) => (namesByPath.get(repoPath) ?? []).map(byName),
  })
}
