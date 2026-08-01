import { afterEach, describe, expect, it } from 'vitest'
import { manifest, repo } from '../manifest/fixtures.js'
import { makeBoundedLogBuffer } from '../logging/logger.js'
import { openStore, type Store } from '../store/db.js'
import { createTicket } from '../store/tickets.js'
import { upsertProject } from '../store/projects.js'
import { SCHEMA_VERSION } from '../store/migrations.js'
import { collectMetadata, collectProjectMetadata } from './collectMetadata.js'
import { createHookChannelRecorder } from './hookChannel.js'
import { createPseudonymizer } from './pseudonymize.js'
import { finalizeReport } from './finalize.js'
import type { DiagnosticSection } from './types.js'

const RUNTIME = {
  extensionVersion: '1.2.3',
  editorVersion: '1.126.0',
  appName: 'Cursor',
  appHost: 'desktop',
  language: 'en',
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v20.18.1',
  electronVersion: '39.0.0',
  nodeAbi: '140',
  remoteNamePresent: false,
  uiKind: 'desktop',
  developmentMode: false,
  uptimeMs: 1_234,
}

function data(section: DiagnosticSection | undefined): Record<string, unknown> {
  if (!section || section.status === 'unavailable') throw new Error('section unavailable')
  return section.data as Record<string, unknown>
}

describe('host evidence sections', () => {
  let store: Store | undefined
  afterEach(() => store?.close())

  function common(failureLogText?: string) {
    const recorder = createHookChannelRecorder()
    recorder.record('accepted', 'PostToolUse')
    recorder.record('not-found', 'PostToolUse')
    recorder.record('unknown-worktree', 'Stop')
    return {
      store: store!,
      manifest: manifest({ api: repo({ repoPath: '/src/api' }) }),
      logs: makeBoundedLogBuffer(),
      reportId: 'report-host',
      generatedAt: '2026-08-01T00:00:00.000Z',
      aliases: createPseudonymizer(new Uint8Array(32).fill(9)),
      runtime: RUNTIME,
      hooks: {
        channel: recorder.snapshot(),
        ...(failureLogText === undefined
          ? {}
          : { failureLogPath: '/storage/codex/hook-failures.jsonl', readText: () => failureLogText }),
      },
    }
  }

  it('reports the runtime the extension host is actually running in', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    const draft = await collectMetadata({ ...common(), project, ticketId: ticket.id })
    expect(data(draft.metadata.runtime)).toMatchObject({
      appName: 'Cursor',
      nodeVersion: 'v20.18.1',
      electronVersion: '39.0.0',
      nodeAbi: '140',
      uptimeMs: 1_234,
    })
  })

  it('states whether the registry is migrated and how large it is', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    createTicket(store, { projectId: project.id, key: 'K-2', title: 't2' })
    const draft = await collectMetadata({ ...common(), project, ticketId: ticket.id })
    const registry = data(draft.metadata.registry)
    expect(registry.schemaVersion).toBe(SCHEMA_VERSION)
    expect(registry.expectedSchemaVersion).toBe(SCHEMA_VERSION)
    expect(registry.migrated).toBe(true)
    expect(registry.ticketsInProject).toBe(2)
    expect((registry.rowCounts as Record<string, number>).tickets).toBe(2)
  })

  it('pairs the endpoint counters with the bridge failures the agent exited on', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    const log = [
      '{"at":"2026-08-01T09:00:00.000Z","event":"PostToolUse","outcome":"http-error"}',
      '{"at":"2026-08-01T09:01:00.000Z","event":"PostToolUse","outcome":"http-error"}',
      '',
    ].join('\n')
    const draft = await collectMetadata({ ...common(log), project, ticketId: ticket.id })
    const hooks = data(draft.metadata.hooks)
    expect(hooks.channel).toMatchObject({
      requests: 3,
      outcomes: { accepted: 1, 'not-found': 1, 'unknown-worktree': 1 },
    })
    expect(hooks.bridge).toMatchObject({
      present: true,
      failures: 2,
      byOutcome: { 'http-error': 2 },
      newestAt: '2026-08-01T09:01:00.000Z',
    })
  })

  it('treats no bridge log as absence and still finalizes', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    const draft = await collectMetadata({ ...common(), project, ticketId: ticket.id })
    expect(data(draft.metadata.hooks).bridge).toEqual({ present: false })
    expect(() => finalizeReport({ ...draft, contextStatus: 'declined' })).not.toThrow()
  })

  it('carries the same host sections into an extension-level report', async () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const draft = await collectProjectMetadata({ ...common(), project })
    expect(data(draft.metadata.registry).migrated).toBe(true)
    expect(data(draft.metadata.hooks).channel).toMatchObject({ requests: 3 })
    expect(data(draft.metadata.runtime).nodeAbi).toBe('140')
  })
})
