import { describe, expect, it } from 'vitest'
import { manifest, runnableRepo, repo } from '../manifest/fixtures.js'
import { createPseudonymizer } from './pseudonymize.js'
import { projectEffectiveConfig } from './projectConfig.js'

describe('projectEffectiveConfig', () => {
  it('allowlists only effective behavior for selected repositories and approach', () => {
    const config = manifest({
      api: runnableRepo(
        {
          start: 'TOKEN=never-export-me npm start',
          health: 'https://user:pass@private.test/health',
          dependsOn: [{
            target: 'db',
            port: 'db',
            bind: [{ env: 'DATABASE_URL', template: 'secret-template' }],
          }],
        },
        {
          repoPath: '/Users/private/api',
          baselineBranch: 'private-branch',
          hasMigrations: true,
          signals: ['private-signal'],
        },
      ),
      db: repo({ repoPath: '/Users/private/db' }),
      unrelated: repo({ repoPath: '/Users/private/unrelated' }),
    }, {
      id: 'private-project-id',
      host: '127.0.0.1',
      approaches: [
        {
          id: 'rpi',
          label: 'RPI',
          entrypoint: 'research',
          source: { type: 'git', repo: 'https://secret.test/repo', ref: 'secret', include: ['secret'] },
          workflow: [{ name: 'research', command: '/secret-command' }],
        },
        { id: 'unrelated-approach', label: 'Never include me' },
      ],
      conventions: { commitMessage: 'secret convention' },
      ticketing: { provider: 'clickup', teamId: 'secret-team', listId: 'secret-list' },
    })
    const aliases = createPseudonymizer(new Uint8Array(32).fill(4))
    const result = projectEffectiveConfig(config, {
      projectIdentity: 'private-project-id',
      selectedRepos: ['api'],
      selectedApproach: 'rpi',
      resolvedModel: 'model-a',
      resolvedProvider: 'claude',
      aliases,
      repositoryAlias: (name) => ({ api: 'repo_1', db: 'repo_2' })[name] ?? 'repo_other',
    })
    const serialized = JSON.stringify(result)

    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0]).toMatchObject({
      name: 'repo_1',
      runnable: true,
      hasMigrations: true,
      startCommandPresent: true,
      healthCheckPresent: true,
      dependencyCount: 1,
      dependencyTargets: ['repo_2'],
    })
    expect(result.approach).toMatchObject({
      id: 'rpi',
      sourceType: 'git',
      workflowPhaseCount: 1,
      workflowPhases: ['research'],
    })
    for (const forbidden of [
      '/Users/private',
      'never-export-me',
      'user:pass',
      'private-signal',
      'secret-template',
      'unrelated',
      'secret convention',
      'secret-team',
      'secret-list',
      '/secret-command',
    ]) expect(serialized).not.toContain(forbidden)
  })
})
