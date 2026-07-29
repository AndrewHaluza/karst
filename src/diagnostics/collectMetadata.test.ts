import { afterEach, describe, expect, it } from 'vitest'
import { manifest, repo } from '../manifest/fixtures.js'
import { makeBoundedLogBuffer } from '../logging/logger.js'
import { openStore, type Store } from '../store/db.js'
import { createTicket } from '../store/tickets.js'
import { upsertProject } from '../store/projects.js'
import { CollectionCancelledError, collectMetadata } from './collectMetadata.js'
import { createPseudonymizer } from './pseudonymize.js'

describe('collectMetadata', () => {
  let store: Store | undefined
  afterEach(() => store?.close())

  it('collects scoped read-only metadata, yielding before database work', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, {
      slug: 'private-project',
      rootPath: '/Users/private/project',
    })
    const other = upsertProject(store, { slug: 'other-project' })
    const ticket = createTicket(store, {
      projectId: project.id,
      key: 'SECRET-7',
      title: 'FORBIDDEN_TITLE',
      description: 'FORBIDDEN_DESCRIPTION',
    })
    createTicket(store, {
      projectId: other.id,
      key: 'SECRET-7',
      title: 'OTHER_PROJECT_TITLE',
      description: 'OTHER_PROJECT_DESCRIPTION',
    })
    store.db.prepare(
      `UPDATE tickets SET brief = 'FORBIDDEN_BRIEF', session_id = 'raw-session',
       selected_repos = '["RAW_REPOSITORY_IDENTIFIER"]', approach = 'rpi', model = 'model-a'
       WHERE id = ?`,
    ).run(ticket.id)
    store.db.prepare(
      `UPDATE stages SET status = 'failed', attempt = 2,
       verdict = 'token=stage-secret', artifact_path = '/private/artifact'
       WHERE ticket_id = ? AND stage_key = 'impl'`,
    ).run(ticket.id)
    // `worktrees.repo`, `prs.repo` and `merge_checks.repo` hold the repoPath —
    // NOT the repository name `selected_repos` and `servers` use. The fixture
    // says so, because a fixture that keyed them by name is what hid the
    // two-namespaces-one-counter aliasing bug.
    store.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, '/private/api', '/private/worktree',
               'private-branch', 'private-base', 'inherited')`,
    ).run(ticket.id)
    store.db.prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status)
       VALUES (?, '/private/api', 7, 'https://private.test/7', 'open')`,
    ).run(ticket.id)
    store.db.prepare(
      `INSERT INTO merge_checks
       (ticket_id, repo, state, files, checked_at)
       VALUES (?, '/private/api', 'clean', '[]',
               '2026-07-28T00:00:00.000Z')`,
    ).run(ticket.id)
    const logs = makeBoundedLogBuffer()
    logs.capture({
      timestamp: '2026-07-28T00:00:00.000Z',
      level: 'error',
      message: 'Authorization: Bearer raw-log-secret',
    })

    const statements: string[] = []
    const originalPrepare = store.db.prepare.bind(store.db)
    const recordingStore = {
      ...store,
      db: new Proxy(store.db, {
        get(target, property, receiver) {
          if (property !== 'prepare') return Reflect.get(target, property, receiver)
          return (sql: string) => {
            if (!/^\s*(?:SELECT|PRAGMA)\b/i.test(sql)) {
              throw new Error(`diagnostics attempted non-read SQL: ${sql}`)
            }
            statements.push(sql)
            return originalPrepare(sql)
          }
        },
      }),
    } as Store
    const pending = collectMetadata({
      store: recordingStore,
      project,
      manifest: manifest({
        RAW_REPOSITORY_IDENTIFIER: repo({ repoPath: '/private/api' }),
      }, {
        id: 'private-project',
        approaches: [{ id: 'rpi', label: 'RPI' }],
      }),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1.2.3',
        editorVersion: '1.126.0',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: true,
      },
      logs,
      reportId: 'report-1',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(5)),
    })
    expect(statements).toEqual([])
    const draft = await pending
    const serialized = JSON.stringify(draft)

    expect(draft.contextStatus).toBe('not-requested')
    expect(draft.context).toBeUndefined()
    expect(draft.metadata.ticket?.status).toBe('available')
    expect(draft.metadata.stages?.status).toBe('available')
    expect(draft.metadata.logs?.status).toBe('available')
    expect(serialized).toContain('[REDACTED:authorization]')
    expect(serialized.match(/repo_1/g)?.length).toBeGreaterThanOrEqual(4)
    expect(statements.length).toBeGreaterThan(0)
    expect(statements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true)
    for (const forbidden of [
      'FORBIDDEN_TITLE',
      'FORBIDDEN_DESCRIPTION',
      'FORBIDDEN_BRIEF',
      'OTHER_PROJECT',
      'SECRET-7',
      'raw-session',
      'stage-secret',
      '/private/',
      'private-branch',
      'private-base',
      'raw-log-secret',
      'RAW_REPOSITORY_IDENTIFIER',
    ]) expect(serialized).not.toContain(forbidden)
  })

  it('rejects a ticket outside the bound project before collecting evidence', async () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const other = upsertProject(localStore, { slug: 'two' })
    const ticket = createTicket(localStore, { projectId: other.id, key: 'X', title: 'x' })
    await expect(collectMetadata({
      store: localStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-2',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(6)),
    })).rejects.toThrow('does not belong to the current project')
  })

  it('discloses a recoverable evidence-reader failure without leaking its error', async () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    const originalPrepare = localStore.db.prepare.bind(localStore.db)
    const failingStore = {
      ...localStore,
      db: new Proxy(localStore.db, {
        get(target, property, receiver) {
          if (property !== 'prepare') return Reflect.get(target, property, receiver)
          return (sql: string) => {
            if (/\bFROM\s+gate_runs\b/i.test(sql)) throw new Error('PRIVATE_READER_ERROR')
            return originalPrepare(sql)
          }
        },
      }),
    } as Store
    const draft = await collectMetadata({
      store: failingStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-3',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(7)),
    })
    expect(draft.metadata.gateRuns).toEqual({
      status: 'unavailable',
      reason: 'reader_failed',
    })
    expect(JSON.stringify(draft)).not.toContain('PRIVATE_READER_ERROR')
  })

  it('stays responsive at bounded history limits and discloses row/log truncation', async () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    for (let i = 0; i <= 500; i++) {
      localStore.db.prepare(
        `INSERT INTO gate_runs
          (ticket_id, stage_key, attempt, run_at, gate_name, exit_code)
         VALUES (?, 'uat', ?, ?, 'test', 0)`,
      ).run(ticket.id, i, `2026-07-28T00:00:${String(i % 60).padStart(2, '0')}.000Z`)
      localStore.db.prepare(
        `INSERT INTO phase_marks
          (ticket_id, stage_key, attempt, phase_name, marked_at)
         VALUES (?, 'impl', ?, 'implement', ?)`,
      ).run(ticket.id, i, `2026-07-28T00:00:${String(i % 60).padStart(2, '0')}.000Z`)
    }
    const logs = makeBoundedLogBuffer()
    for (let i = 0; i <= 200; i++) {
      logs.capture({
        timestamp: `2026-07-28T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        level: 'info',
        message: `entry-${i}`,
      })
    }
    let heartbeats = 0
    const timer = setInterval(() => { heartbeats++ }, 0)
    const draft = await collectMetadata({
      store: localStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs,
      reportId: 'report-bounded',
      generatedAt: '2026-07-28T00:01:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(8)),
    })
    clearInterval(timer)
    expect(heartbeats).toBeGreaterThanOrEqual(3)
    expect(draft.metadata.gateRuns).toMatchObject({
      status: 'truncated',
      omitted: 1,
      reason: 'rows',
    })
    expect(draft.metadata.phaseMarks).toMatchObject({
      status: 'truncated',
      omitted: 1,
      reason: 'rows',
    })
    expect(draft.metadata.logs).toMatchObject({
      status: 'truncated',
      omitted: 1,
      reason: 'rows',
    })
  })

  it('abandons collection mid-flight when the caller cancels', async () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    let reads = 0
    const countingStore = {
      ...localStore,
      db: new Proxy(localStore.db, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (sql: string) => {
              reads++
              return localStore.db.prepare(sql)
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      }),
    } as Store
    // Cancelled after the first yield: the progress UI advertises cancellation,
    // so a cancel click must stop the read sequence, not merely be noticed once
    // the whole bounded collection has already run.
    let cancelled = false
    const promise = collectMetadata({
      store: countingStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-cancel',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(9)),
      isCancelled: () => cancelled,
    })
    cancelled = true
    await expect(promise).rejects.toBeInstanceOf(CollectionCancelledError)
    const readsAtCancel = reads
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads).toBe(readsAtCancel)
  })

  it('marks topology and pull-request sections unavailable on their reader failures', async () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    const originalPrepare = localStore.db.prepare.bind(localStore.db)
    const failingStore = {
      ...localStore,
      db: new Proxy(localStore.db, {
        get(target, property, receiver) {
          if (property !== 'prepare') return Reflect.get(target, property, receiver)
          return (sql: string) => {
            if (/\bFROM\s+(?:worktrees|prs)\b/i.test(sql)) throw new Error('PRIVATE_FAILURE')
            return originalPrepare(sql)
          }
        },
      }),
    } as Store
    const draft = await collectMetadata({
      store: failingStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-unavailable',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(9)),
    })
    expect(draft.metadata.topology).toEqual({
      status: 'unavailable',
      reason: 'reader_failed',
    })
    expect(draft.metadata.pullRequest).toEqual({
      status: 'unavailable',
      reason: 'reader_failed',
    })
    expect(JSON.stringify(draft)).not.toContain('PRIVATE_FAILURE')
  })

  it('marks a dropped metadata value rather than rendering it as absent', async () => {
    // A value the sanitizer refuses to emit must stay visible as a dropped
    // field: `null` is indistinguishable from "this column was never set", and
    // the sanitizer records no redaction category for the omitting paths, so a
    // silent null would leave the reader no trace that anything was removed.
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    localStore.db.prepare('UPDATE tickets SET approach = ?, source = ? WHERE id = ?')
      .run('a'.repeat(40 * 1024), 'manual', ticket.id)

    const draft = await collectMetadata({
      store: localStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-omitted',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(4)),
    })

    const ticketSection = draft.metadata.ticket
    expect(ticketSection?.status).toBe('available')
    const data = (ticketSection as { data: Record<string, unknown> }).data
    expect(data.approach).toBe('[OMITTED:unsafe-metadata]')
    // An unset column still reads as absent, and a clean value passes through.
    expect(data.agentRole).toBeNull()
    expect(data.source).toBe('manual')
    expect(draft.redactions.omitted).toBe(1)
  })

  it('gives one repository one alias whether evidence keys it by name or by path', async () => {
    // `tickets.selected_repos` and `servers` are keyed by repository NAME;
    // `worktrees`, `prs` and `merge_checks` are keyed by its repoPath. Aliasing
    // both namespaces through one counter minted a SECOND alias for the same
    // repository, so a two-repository report listed repo_1/repo_2 under
    // effectiveConfig and repo_3/repo_4 under topology and pullRequest — four
    // repositories where the project has two, and no way to tell which pair was
    // which.
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    localStore.db.prepare(
      `UPDATE tickets SET selected_repos = '["api","web"]' WHERE id = ?`,
    ).run(ticket.id)
    for (const [name, repoPath] of [['api', '/src/api'], ['web', '/src/web']] as const) {
      localStore.db.prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, 'feat/x', 'develop', 'inherited')`,
      ).run(ticket.id, repoPath, `${repoPath}/.karst/worktrees/x`)
      localStore.db.prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, status)
         VALUES (?, ?, 'localhost', 4000, 'running')`,
      ).run(ticket.id, name)
    }
    localStore.db.prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status)
       VALUES (?, '/src/api', 7, 'https://example.test/7', 'open')`,
    ).run(ticket.id)
    localStore.db.prepare(
      `INSERT INTO merge_checks (ticket_id, repo, state, files, checked_at)
       VALUES (?, '/src/web', 'clean', '[]', '2026-07-28T00:00:00.000Z')`,
    ).run(ticket.id)

    const draft = await collectMetadata({
      store: localStore,
      project,
      manifest: manifest({
        api: repo({ repoPath: '/src/api' }),
        web: repo({ repoPath: '/src/web' }),
      }),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-aliases',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(3)),
    })

    const data = (section: unknown): Record<string, unknown> =>
      (section as { data: Record<string, unknown> }).data
    const ticketRepos = data(draft.metadata.ticket).repositories as string[]
    const configRepos = (data(draft.metadata.effectiveConfig).repositories as { name: string }[])
      .map((entry) => entry.name)
    const topology = data(draft.metadata.topology)
    const worktrees = topology.worktrees as { repositories: string[] }[]
    const servers = topology.servers as { repository: string }[]
    const prs = data(draft.metadata.pullRequest).pullRequests as { repositories: string[] }[]
    const merges = data(draft.metadata.pullRequest).mergeChecks as { repositories: string[] }[]

    expect(ticketRepos).toEqual(['repo_1', 'repo_2'])
    expect(configRepos).toEqual(['repo_1', 'repo_2'])
    expect(worktrees.flatMap((row) => row.repositories).sort()).toEqual(['repo_1', 'repo_2'])
    expect(servers.map((row) => row.repository).sort()).toEqual(['repo_1', 'repo_2'])
    expect(prs.map((row) => row.repositories)).toEqual([['repo_1']])
    expect(merges.map((row) => row.repositories)).toEqual([['repo_2']])
    expect(topology.repositoryOrder).toEqual(['repo_1', 'repo_2'])
    // Only two repositories exist, so a third alias would be one of them counted twice.
    expect(JSON.stringify(draft)).not.toContain('repo_3')
  })

  it('keeps path-keyed evidence correlatable when its manifest entry is gone', async () => {
    // A repository dropped from the manifest still has rows in `worktrees` and
    // `prs`. There is no name left to alias, so `repositories` is honestly
    // empty — but the aliased repoPath still joins those rows to each other,
    // which is what a reader needs to see one repository rather than two.
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const ticket = createTicket(localStore, { projectId: project.id, key: 'X', title: 'x' })
    localStore.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, '/src/removed', '/src/removed/.karst/worktrees/x', 'feat/x', 'develop', 'inherited')`,
    ).run(ticket.id)
    localStore.db.prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status)
       VALUES (?, '/src/removed', 9, 'https://example.test/9', 'open')`,
    ).run(ticket.id)

    const draft = await collectMetadata({
      store: localStore,
      project,
      manifest: manifest({}),
      ticketId: ticket.id,
      runtime: {
        extensionVersion: '1',
        editorVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        remoteNamePresent: false,
        uiKind: 'desktop',
        developmentMode: false,
      },
      logs: makeBoundedLogBuffer(),
      reportId: 'report-orphan',
      generatedAt: '2026-07-28T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(2)),
    })

    const topology = (draft.metadata.topology as { data: Record<string, unknown> }).data
    const prs = (draft.metadata.pullRequest as { data: Record<string, unknown> }).data
      .pullRequests as { repositories: string[]; repoPathRef: string }[]
    const worktrees = topology.worktrees as { repositories: string[]; repoPathRef: string }[]
    expect(worktrees[0]?.repositories).toEqual([])
    expect(prs[0]?.repositories).toEqual([])
    expect(prs[0]?.repoPathRef).toBe(worktrees[0]?.repoPathRef)
    expect(JSON.stringify(draft)).not.toContain('/src/removed')
  })
})
