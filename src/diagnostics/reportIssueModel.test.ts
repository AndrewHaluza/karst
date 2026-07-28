import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_ACTIONS,
  DISCLOSURE,
  buildGitHubIssueUrl,
  buildReviewSummary,
  makeDocumentPaths,
  reportFileName,
  ticketCandidates,
} from './reportIssueModel.js'
import type { FinalizedDiagnosticReport } from './types.js'

function snapshot(): FinalizedDiagnosticReport {
  const markdown = '# exact reviewed bytes\n'
  return {
    report: {
      reportVersion: 1,
      reportId: 'report-safe-1',
      generatedAt: '2026-07-28T15:36:00.000Z',
      contextStatus: 'declined',
      metadata: {
        stages: { status: 'truncated', data: [], omitted: 2, reason: 'rows' },
        logs: { status: 'unavailable', reason: 'reader_failed' },
      },
      exclusions: ['secrets'],
      redactions: { token: 3 },
    },
    markdown,
    json: '{}\n',
    checksum: 'a'.repeat(64),
    exportMarkdown: () => markdown,
    exportJson: () => '{}\n',
  }
}

describe('issue report UI model', () => {
  it('registers a Command Palette entry', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }> }
    }
    expect(pkg.contributes.commands).toContainEqual({
      command: 'karst.reportIssue',
      title: 'Karst: Report Issue',
    })
  })

  it('lists only current-project tickets and accepts an owned argument', () => {
    const tickets = [
      {
        id: 1,
        projectId: 7,
        key: 'K-1',
        title: 'First',
        stageCurrent: 'impl',
        updatedAt: '2026-07-28 15:36:00',
      },
      { id: 2, projectId: 8, key: 'X-1', title: 'Other', stageCurrent: 'uat' },
    ]
    expect(ticketCandidates(tickets, 7)).toEqual([
      {
        id: 1,
        label: 'K-1 — First',
        description: 'Stage: impl · Updated: 2026-07-28 15:36:00',
      },
    ])
    expect(ticketCandidates(tickets, 7, 1)[0]?.id).toBe(1)
    expect(() => ticketCandidates(tickets, 7, 2)).toThrow('scoped_not_found')
  })

  it('keeps metadata, optional context, and permanent exclusions distinct', () => {
    expect(DISCLOSURE.included).toContain('diagnostic metadata')
    expect(DISCLOSURE.notIncluded).toContain('ticket description')
    expect(DISCLOSURE.alwaysExcluded).toContain('credentials')
    expect(CONTEXT_ACTIONS).toEqual([
      'Continue without context',
      'Include context for this report',
      'Back',
    ])
  })

  it('summarizes final context, truncation, unavailability, redactions and caveats', () => {
    const summary = buildReviewSummary(snapshot())
    expect(summary).toContain('Metadata only')
    expect(summary).toContain('stages: truncated')
    expect(summary).toContain('logs: unavailable')
    expect(summary).toContain('token: 3')
    expect(summary).toContain('point-in-time')
    expect(summary).toContain('latest session reference')
  })

  it('builds a fixed safe GitHub handoff URL without diagnostics', () => {
    const value = snapshot()
    const url = new URL(buildGitHubIssueUrl(value, '1.2.3'))
    expect(url.origin + url.pathname).toBe('https://github.com/AndrewHaluza/karst/issues/new')
    expect(url.searchParams.get('body')).toContain('Report reference: report-safe-1')
    expect(url.searchParams.get('body')).toContain(`Checksum: ${'a'.repeat(64)}`)
    expect(url.searchParams.get('body')).toContain('paste or attach')
    expect(url.toString()).not.toContain('exact+reviewed+bytes')
  })

  it('mints a fresh preview path per render so a re-finalized snapshot is never cached', () => {
    const paths = makeDocumentPaths()
    // "Remove context" refinalizes under the SAME reportId; reusing the URI
    // would make VS Code serve the previously opened (context-included) bytes.
    const first = paths('final', 'report-safe-1')
    const second = paths('final', 'report-safe-1')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^\/final\/report-safe-1-\d+\.md$/)
    expect(paths('metadata', 'a/b?c')).toContain(encodeURIComponent('a/b?c'))
    expect(makeDocumentPaths()('final', 'report-safe-1')).toBe(first)
  })

  it('creates a sanitized deterministic suggested filename', () => {
    expect(reportFileName('A/B secret', '2026-07-28T15:36:00.000Z'))
      .toBe('karst-issue-A-B-secret-2026-07-28T153600Z.md')
  })
})
