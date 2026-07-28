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
})
