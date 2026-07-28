import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  DiagnosticDraft,
  DiagnosticReportV1,
  DiagnosticSection,
  FinalizedDiagnosticReport,
} from './types.js'

describe('diagnostic contracts', () => {
  it('models available, truncated, and unavailable sections explicitly', () => {
    const sections: DiagnosticSection<readonly string[]>[] = [
      { status: 'available', data: ['ok'] },
      { status: 'truncated', data: ['newest'], omitted: 2, reason: 'rows' },
      { status: 'unavailable', reason: 'reader_failed' },
    ]
    expect(sections.map(section => section.status)).toEqual([
      'available',
      'truncated',
      'unavailable',
    ])
  })

  it('requires a concrete truncation dimension', () => {
    const reasons: Array<Extract<DiagnosticSection, { status: 'truncated' }>['reason']> = [
      'rows',
      'age',
      'bytes',
    ]
    expect(reasons).toEqual(['rows', 'age', 'bytes'])
  })

  it('uses a closed metadata section registry', () => {
    const draft: DiagnosticDraft = {
      reportId: 'r',
      generatedAt: '2026-01-01T00:00:00.000Z',
      contextStatus: 'not-requested',
      metadata: { runtime: { status: 'available', data: {} } },
      exclusions: [],
      redactions: {},
    }
    expect(Object.keys(draft.metadata)).toEqual(['runtime'])
  })

  it('keeps drafts separate from finalized opaque bytes', () => {
    expectTypeOf<DiagnosticDraft>().not.toEqualTypeOf<DiagnosticReportV1>()
    expectTypeOf<FinalizedDiagnosticReport['markdown']>().toEqualTypeOf<string>()
    expectTypeOf<FinalizedDiagnosticReport['checksum']>().toEqualTypeOf<string>()
  })
})
