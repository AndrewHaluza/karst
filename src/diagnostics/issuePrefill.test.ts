import { describe, expect, it } from 'vitest'
import { buildIssuePrefill, MAX_PREFILL_BODY_CHARS } from './issuePrefill.js'
import type { DiagnosticSections, FinalizedDiagnosticReport } from './types.js'

function snapshot(
  metadata: DiagnosticSections,
  overrides: Partial<FinalizedDiagnosticReport['report']> = {},
): FinalizedDiagnosticReport {
  const markdown = '# reviewed bytes\n'
  return {
    report: {
      reportVersion: 1,
      reportId: 'report-1',
      generatedAt: '2026-08-01T10:00:00.000Z',
      contextStatus: 'declined',
      metadata,
      exclusions: [],
      redactions: {},
      ...overrides,
    },
    markdown,
    json: '{}\n',
    checksum: 'c'.repeat(64),
    exportMarkdown: () => markdown,
    exportJson: () => '{}\n',
  }
}

const RUNTIME = {
  status: 'available' as const,
  data: {
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
    uptimeMs: 4200,
  },
}

describe('GitHub issue prefill', () => {
  it('fills the operational environment a blank form leaves empty', () => {
    const prefill = buildIssuePrefill(
      snapshot({
        runtime: RUNTIME,
        registry: {
          status: 'available',
          data: { schemaVersion: 17, expectedSchemaVersion: 18, migrated: false },
        },
        ticket: {
          status: 'available',
          data: {
            currentStage: 'impl',
            agentState: 'waiting',
            resolvedProvider: 'codex',
            resolvedModel: 'gpt-5-codex',
          },
        },
        effectiveConfig: { status: 'available', data: { ticketingProvider: 'clickup' } },
      }),
      '1.2.3',
    )
    expect(prefill.title).toBe('[Karst 1.2.3] ')
    expect(prefill.body).toContain('| Karst | 1.2.3 |')
    expect(prefill.body).toContain('| Editor | Cursor 1.126.0 · desktop · desktop |')
    expect(prefill.body).toContain('| Platform | darwin arm64 |')
    expect(prefill.body).toContain('| Runtime | Node v20.18.1 · Electron 39.0.0 · ABI 140 |')
    expect(prefill.body).toContain('| Remote workspace | no |')
    expect(prefill.body).toContain('| Agent | codex · gpt-5-codex |')
    expect(prefill.body).toContain('| Ticketing | clickup |')
    expect(prefill.body).toContain('| Stage | impl · waiting |')
    // The stale-registry case the CLI reports as `no such column` without this.
    expect(prefill.body).toContain('| Registry schema | v17 (expected v18) |')
    expect(prefill.body).toContain('- Report reference: report-1')
    expect(prefill.body).toContain(`- Checksum: ${'c'.repeat(64)}`)
    expect(prefill.body).toContain('- Redactions: none')
  })

  it('names both sides of a hook failure', () => {
    const prefill = buildIssuePrefill(
      snapshot({
        hooks: {
          status: 'available',
          data: {
            channel: {
              requests: 40,
              outcomes: { accepted: 30, 'not-found': 10, aborted: 0 },
              events: { PostToolUse: 40 },
              firstAt: '2026-08-01T09:00:00.000Z',
              lastAt: '2026-08-01T10:00:00.000Z',
            },
            bridge: {
              present: true,
              failures: 10,
              byOutcome: { 'http-error': 10 },
              byEvent: { PostToolUse: 10 },
              oldestAt: '2026-08-01T09:00:00.000Z',
              newestAt: '2026-08-01T09:59:00.000Z',
              unparsedLines: 0,
              recent: [],
            },
          },
        },
      }),
      '1.2.3',
    )
    expect(prefill.body).toContain('### Hook channel')
    expect(prefill.body).toContain('- Endpoint: 40 request(s) — accepted 30, not-found 10')
    expect(prefill.body).toContain(
      '- Codex bridge: 10 failure(s) — http-error 10 (newest 2026-08-01T09:59:00.000Z)',
    )
    // A zero count is noise in a form a human reads.
    expect(prefill.body).not.toContain('aborted')
  })

  it('omits the hook section entirely when no channel was observed', () => {
    const prefill = buildIssuePrefill(snapshot({ runtime: RUNTIME }), '1.2.3')
    expect(prefill.body).not.toContain('### Hook channel')
  })

  it('states section notices and redaction categories', () => {
    const prefill = buildIssuePrefill(
      snapshot(
        {
          logs: { status: 'truncated', data: [], omitted: 12, reason: 'bytes' },
          stages: { status: 'unavailable', reason: 'reader_failed' },
        },
        { redactions: { authorization: 3 } },
      ),
      '1.2.3',
    )
    expect(prefill.body).toContain('logs truncated (12 omitted by bytes)')
    expect(prefill.body).toContain('stages unavailable (reader_failed)')
    expect(prefill.body).toContain('- Redactions: authorization 3')
  })

  it('degrades to the sections it has rather than emitting empty rows', () => {
    const prefill = buildIssuePrefill(snapshot({}), '9.9.9')
    expect(prefill.body).not.toMatch(/\|\s*\|/)
    expect(prefill.body).toContain('- Report reference: report-1')
    expect(prefill.title).toBe('[Karst 9.9.9] ')
  })

  it('never lets one field break the table or run away with the URL', () => {
    const prefill = buildIssuePrefill(
      snapshot({
        runtime: {
          status: 'available',
          data: {
            extensionVersion: `1.0.0 | injected\nrow`,
            editorVersion: 'x'.repeat(400),
            platform: 'linux',
            arch: 'x64',
            remoteNamePresent: false,
            uiKind: 'desktop',
            developmentMode: false,
          },
        },
      }),
      '1.0.0',
    )
    const environment = prefill.body.split('\n').filter((line) => line.startsWith('| Karst'))
    expect(environment).toHaveLength(1)
    expect(environment[0]).toBe('| Karst | 1.0.0 injected row |')
    expect(prefill.body).toContain('…')
    expect(prefill.body.length).toBeLessThanOrEqual(MAX_PREFILL_BODY_CHARS + 200)
  })

  it('truncates a body that would outgrow the URL and says the report is complete', () => {
    const prefill = buildIssuePrefill(
      snapshot({}, { redactions: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [`category${index}`, index + 1]),
      ) }),
      '1.2.3',
    )
    expect(prefill.truncated).toBe(true)
    expect(prefill.body).toContain('the attached report is complete')
  })
})
