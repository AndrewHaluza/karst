import { describe, expect, it } from 'vitest'
import { EVIDENCE_PREFIXES, isEvidenceMessage, ticketPatternFor } from './logEvidence.js'

describe('log evidence vocabulary', () => {
  it('matches every DBG-03 evidence prefix and no other prefix', () => {
    for (const prefix of EVIDENCE_PREFIXES) {
      expect(isEvidenceMessage(`${prefix} something`)).toBe(true)
    }
    // `[driver]` is chatter unless it names the ticket (a report-time rule).
    expect(isEvidenceMessage('[driver] delivery T1: notes deferred')).toBe(false)
    expect(isEvidenceMessage('ordinary info line')).toBe(false)
  })

  it('does not let a longer prefix masquerade as an evidence prefix', () => {
    expect(isEvidenceMessage('[staged] to review')).toBe(true)
    expect(isEvidenceMessage('[stages] rollup')).toBe(false)
  })

  it('builds a ticket pattern for a numeric id and none for a project report', () => {
    const pattern = ticketPatternFor(659)
    expect(pattern).not.toBeNull()
    expect(pattern!.test('delivery T659: notes deferred')).toBe(true)
    expect(pattern!.test('ticket 659 blocked')).toBe(true)
    // A longer/shorter number is a different ticket.
    expect(pattern!.test('delivery T6590: notes deferred')).toBe(false)
    expect(pattern!.test('delivery T65: notes deferred')).toBe(false)
    expect(ticketPatternFor(null)).toBeNull()
  })
})
