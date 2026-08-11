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

  it('surfaces hook-channel counters at review time, before anything is exported', () => {
    const value = snapshot()
    const withHooks: FinalizedDiagnosticReport = {
      ...value,
      report: {
        ...value.report,
        metadata: {
          ...value.report.metadata,
          hooks: {
            status: 'available',
            data: {
              channel: { requests: 12, outcomes: { accepted: 6, 'not-found': 6 } },
              bridge: { present: true, failures: 6, byOutcome: { 'http-error': 6 } },
            },
          },
        },
      },
    }
    const summary = buildReviewSummary(withHooks)
    expect(summary).toContain('Hook channel:')
    expect(summary).toContain('Endpoint: 12 request(s) — accepted 6, not-found 6')
    expect(summary).toContain('Codex bridge: 6 failure(s) — http-error 6')
    // Absent counters stay absent rather than printing an empty heading.
    expect(buildReviewSummary(value)).not.toContain('Hook channel:')
  })

  function withCores(): FinalizedDiagnosticReport {
    const value = snapshot()
    return {
      ...value,
      report: {
        ...value.report,
        metadata: {
          ...value.report.metadata,
          cores: {
            status: 'available',
            data: [
              {
                core: 'opencode',
                headlessCalls: 12,
                headlessTokens: { input: 900000, output: 400000, total: 1300000 },
                interactiveCalls: 2,
                interactiveTokens: { input: 10, output: 5, total: 15 },
                sessions: 2,
                models: ['opencode-go/deepseek-v4-flash'],
                firstSeenAt: '2026-08-01T00:00:00.000Z',
                lastSeenAt: '2026-08-02T00:00:00.000Z',
              },
              {
                core: 'codex',
                headlessCalls: 3,
                headlessTokens: { input: 4000, output: 4400, total: 8400 },
                interactiveCalls: 0,
                interactiveTokens: { input: 0, output: 0, total: 0 },
                sessions: 1,
                models: ['gpt-5-codex'],
                firstSeenAt: null,
                lastSeenAt: null,
              },
            ],
          },
        },
      },
    }
  }

  it('names every used agent core in the review summary', () => {
    const summary = buildReviewSummary(withCores())
    expect(summary).toContain('Cores used:')
    expect(summary).toContain('opencode (12 headless · 2 interactive · 2 sessions · 1.3M tokens)')
    expect(summary).toContain('codex (3 headless · 1 session · 8.4k tokens)')
  })

  it('omits the cores line when the section is unavailable', () => {
    const value = snapshot()
    const summary = buildReviewSummary({
      ...value,
      report: {
        ...value.report,
        metadata: {
          ...value.report.metadata,
          cores: { status: 'unavailable', reason: 'reader_failed' },
        },
      },
    })
    expect(summary).not.toContain('Cores used:')
  })

  it('builds a fixed safe GitHub handoff URL without diagnostics', () => {
    const value = snapshot()
    const url = new URL(buildGitHubIssueUrl(value, '1.2.3'))
    expect(url.origin + url.pathname).toBe('https://github.com/AndrewHaluza/karst/issues/new')
    // Prefilled from the reviewed snapshot: the form is never blank metadata.
    expect(url.searchParams.get('title')).toBe('[Karst 1.2.3] ')
    expect(url.searchParams.get('body')).toContain('Report reference: report-safe-1')
    expect(url.searchParams.get('body')).toContain(`Checksum: ${'a'.repeat(64)}`)
    expect(url.searchParams.get('body')).toContain('stages truncated (2 omitted by rows)')
    expect(url.searchParams.get('body')).toContain('Redactions: token 3')
    expect(url.searchParams.get('body')).toContain('paste or attach')
    // The report itself is still not uploaded — only what the reporter reviewed
    // as metadata is described, never the report bytes.
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
