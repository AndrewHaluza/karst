import { describe, expect, it } from 'vitest'
import { renderDiagnosticMarkdown } from './renderMarkdown.js'
import type { DiagnosticReportV1 } from './types.js'

describe('Markdown rendering safety', () => {
  it('uses a fence longer than backtick runs in arbitrary values', () => {
    const report: DiagnosticReportV1 = {
      reportVersion: 1,
      reportId: 'r',
      generatedAt: '2026-01-01T00:00:00.000Z',
      contextStatus: 'not-requested',
      metadata: {
        logs: { status: 'available', data: [{ message: 'hostile ``` markdown' }] },
      },
      exclusions: [],
      redactions: {},
    }
    const markdown = renderDiagnosticMarkdown(report)
    expect(markdown).toContain('````json')
    expect(markdown).toContain('\n````\n')
  })

  it('surfaces the additive omittedByClass breakdown when a producer sets it', () => {
    const report: DiagnosticReportV1 = {
      reportVersion: 1,
      reportId: 'r',
      generatedAt: '2026-01-01T00:00:00.000Z',
      contextStatus: 'not-requested',
      metadata: {
        logs: {
          status: 'truncated',
          data: [],
          omitted: 7,
          reason: 'rows',
          omittedByClass: { warnError: 0, ticket: 2, other: 4, age: 1 },
        },
      },
      exclusions: [],
      redactions: {},
    }
    const markdown = renderDiagnosticMarkdown(report)
    expect(markdown).toContain(
      'truncated by rows (7 omitted: warnError 0, ticket 2, other 4, age 1)',
    )
  })

  it('omits the breakdown for producers that do not classify', () => {
    const report: DiagnosticReportV1 = {
      reportVersion: 1,
      reportId: 'r',
      generatedAt: '2026-01-01T00:00:00.000Z',
      contextStatus: 'not-requested',
      metadata: { logs: { status: 'truncated', data: [], omitted: 3, reason: 'bytes' } },
      exclusions: [],
      redactions: {},
    }
    const markdown = renderDiagnosticMarkdown(report)
    expect(markdown).toContain('truncated by bytes (3 omitted)')
    expect(markdown).not.toContain('warnError')
  })
})
