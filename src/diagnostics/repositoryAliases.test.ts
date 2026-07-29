import { describe, expect, it } from 'vitest'
import { manifest, repo } from '../manifest/fixtures.js'
import { createRepositoryAliases } from './repositoryAliases.js'

describe('createRepositoryAliases', () => {
  it('mints one alias per repository name, in first-seen order', () => {
    const aliases = createRepositoryAliases(manifest({
      api: repo({ repoPath: '/src/api' }),
      web: repo({ repoPath: '/src/web' }),
    }))
    expect(aliases.byName('web')).toBe('repo_1')
    expect(aliases.byName('api')).toBe('repo_2')
    expect(aliases.byName('web')).toBe('repo_1')
  })

  it('resolves a repoPath to the alias its manifest name already holds', () => {
    const aliases = createRepositoryAliases(manifest({ api: repo({ repoPath: '/src/api' }) }))
    expect(aliases.byName('api')).toBe('repo_1')
    expect(aliases.byPath('/src/api')).toEqual(['repo_1'])
  })

  it('names every entry a monorepo path backs', () => {
    // Two `repositories:` entries over one directory is an ordinary monorepo
    // with two runnable processes. They share a worktree, so the row keyed by
    // that path speaks for both — picking one would silently drop the other.
    const aliases = createRepositoryAliases(manifest({
      api: repo({ repoPath: '/mono' }),
      web: repo({ repoPath: '/mono' }),
    }))
    expect(aliases.byPath('/mono')).toEqual(['repo_1', 'repo_2'])
    expect(aliases.byName('api')).toBe('repo_1')
    expect(aliases.byName('web')).toBe('repo_2')
  })

  it('includes a disabled entry — a draft repository still owns worktrees and PRs', () => {
    const aliases = createRepositoryAliases(manifest({
      draft: repo({ repoPath: '/src/draft', enabled: false }),
    }))
    expect(aliases.byPath('/src/draft')).toEqual(['repo_1'])
  })

  it('returns no alias for a path the manifest no longer lists', () => {
    const aliases = createRepositoryAliases(manifest({ api: repo({ repoPath: '/src/api' }) }))
    expect(aliases.byPath('/src/removed')).toEqual([])
  })
})
