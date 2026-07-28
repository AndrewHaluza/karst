import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db.js'
import { upsertProject } from '../store/projects.js'
import { createTicket } from '../store/tickets.js'
import { collectApprovedContext } from './context.js'

describe('collectApprovedContext', () => {
  let store: Store | undefined
  afterEach(() => store?.close())

  it('reads only the disclosed fields from the ticket in the bound project', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'one' })
    const other = upsertProject(store, { slug: 'two' })
    const ticket = createTicket(store, {
      projectId: project.id,
      key: 'SAME-1',
      title: 'User title',
      description: 'User description',
    })
    store.db.prepare(
      `UPDATE tickets
          SET brief = 'User brief', source_ref = 'PRIVATE_SOURCE',
              session_id = 'PRIVATE_SESSION'
        WHERE id = ?`,
    ).run(ticket.id)
    createTicket(store, {
      projectId: other.id,
      key: 'SAME-1',
      title: 'OTHER_PROJECT_TITLE',
      description: 'OTHER_PROJECT_DESCRIPTION',
    })

    const section = collectApprovedContext({
      store,
      projectId: project.id,
      ticketId: ticket.id,
    })
    expect(section).toEqual({
      status: 'available',
      data: {
        title: 'User title',
        description: 'User description',
        brief: 'User brief',
      },
    })
    const serialized = JSON.stringify(section)
    for (const forbidden of [
      'PRIVATE_SOURCE',
      'PRIVATE_SESSION',
      'OTHER_PROJECT',
      'renderedContext',
      'transcript',
      'artifact',
      'repository',
      'environment',
    ]) expect(serialized).not.toContain(forbidden)
  })

  it('rejects cross-project reads and sanitizes or omits unsafe fields', () => {
    store = openStore(':memory:')
    const localStore = store
    const project = upsertProject(localStore, { slug: 'one' })
    const other = upsertProject(localStore, { slug: 'two' })
    const ticket = createTicket(localStore, {
      projectId: other.id,
      key: 'X',
      title: 'Authorization: Bearer abcdefghijklmnop',
      description: 'password=super-secret-value',
    })
    expect(() => collectApprovedContext({
      store: localStore,
      projectId: project.id,
      ticketId: ticket.id,
    })).toThrow(/current project/i)

    const section = collectApprovedContext({
      store: localStore,
      projectId: other.id,
      ticketId: ticket.id,
    })
    expect(JSON.stringify(section)).not.toContain('super-secret-value')
    expect(JSON.stringify(section)).not.toContain('abcdefghijklmnop')
  })

  it('fails closed when a context value exceeds the field cap', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'one' })
    const ticket = createTicket(store, {
      projectId: project.id,
      key: 'X',
      title: 'x'.repeat(100),
      description: 'safe',
    })
    expect(collectApprovedContext({
      store,
      projectId: project.id,
      ticketId: ticket.id,
      maxFieldBytes: 16,
    })).toEqual({
      status: 'truncated',
      data: { title: null, description: 'safe', brief: null },
      omitted: 1,
      reason: 'bytes',
    })
  })
})
