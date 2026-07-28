import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_LIMITS } from './limits.js'

describe('diagnostic limits', () => {
  it('centralizes explicit positive bounds', () => {
    expect(DIAGNOSTIC_LIMITS).toMatchObject({
      maxRowsPerSection: expect.any(Number),
      maxAgeMs: expect.any(Number),
      maxFieldBytes: expect.any(Number),
      maxSectionBytes: expect.any(Number),
      maxTotalBytes: expect.any(Number),
    })
    expect(Object.values(DIAGNOSTIC_LIMITS).every(value => value > 0)).toBe(true)
    expect(Object.isFrozen(DIAGNOSTIC_LIMITS)).toBe(true)
  })
})
