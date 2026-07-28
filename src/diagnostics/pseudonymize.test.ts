import { describe, expect, it } from 'vitest'
import { createPseudonymizer } from './pseudonymize.js'

describe('report-local pseudonyms', () => {
  it('correlates equal values without exposing them', () => {
    const aliases = createPseudonymizer(Buffer.alloc(32, 1))
    const raw = '/Users/alice/private/project'
    expect(aliases.path(raw)).toBe(aliases.path(raw))
    expect(aliases.path(raw)).not.toContain(raw)
  })

  it('uses distinct report keys and type-prefixed aliases', () => {
    const first = createPseudonymizer(Buffer.alloc(32, 1))
    const second = createPseudonymizer(Buffer.alloc(32, 2))
    for (const [type, value] of [
      ['project', 'project-1'],
      ['ticket', 'ticket-1'],
      ['session', 'session-1'],
      ['path', '/private/path'],
      ['branch', 'feat/private'],
      ['baseRef', 'develop'],
    ] as const) {
      const a = first[type](value)
      expect(a).toMatch(new RegExp(`^${type}_[a-f0-9]{12}$`))
      expect(a).not.toBe(second[type](value))
      expect(a).not.toContain(value)
    }
  })
})
