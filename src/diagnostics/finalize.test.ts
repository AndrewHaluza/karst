import { describe, expect, it } from 'vitest'
import { finalizeReport, verifyFinalizedReport } from './finalize.js'
import { renderDiagnosticJson } from './renderJson.js'
import { renderDiagnosticMarkdown } from './renderMarkdown.js'
import type { DiagnosticDraft } from './types.js'

function draft(): DiagnosticDraft {
  return {
    reportId: 'report-1',
    generatedAt: '2026-07-28T12:00:00.000Z',
    contextStatus: 'declined',
    metadata: {
      runtime: { status: 'unavailable', reason: 'reader_failed' },
      logs: { status: 'truncated', data: [{ message: 'safe' }], omitted: 3, reason: 'rows' },
    },
    exclusions: ['credentials', 'environment', 'repository-content', 'session-context'],
    redactions: { secret: 1 },
  }
}

describe('rendering and finalization', () => {
  it('is deterministic, stably ordered, and discloses report states', () => {
    const model = { ...draft(), reportVersion: 1 as const }
    expect(renderDiagnosticJson(model)).toBe(renderDiagnosticJson(model))
    const markdown = renderDiagnosticMarkdown(model)
    expect(markdown.indexOf('logs')).toBeLessThan(markdown.indexOf('runtime'))
    expect(markdown).toContain('truncated')
    expect(markdown).toContain('unavailable')
    expect(markdown).toContain('Context: declined')
    expect(markdown).toContain('Always excluded')
  })

  it('freezes a clone and exports exactly the reviewed bytes', () => {
    const source = draft()
    const finalized = finalizeReport(source)
    ;(source.metadata.logs as unknown as { data: unknown[] }).data.push({ message: 'changed' })
    expect(finalized.markdown).not.toContain('changed')
    expect(finalized.exportMarkdown()).toBe(finalized.markdown)
    expect(finalized.exportJson()).toBe(finalized.json)
    expect(Object.isFrozen(finalized.report)).toBe(true)
    expect(Object.isFrozen(finalized.report.metadata)).toBe(true)
    expect(Object.isFrozen(
      (finalized.report.metadata.logs as unknown as { data: unknown[] }).data,
    )).toBe(true)
    expect(verifyFinalizedReport(finalized)).toBe(true)
  })

  it('enforces approved-context consistency', () => {
    expect(() => finalizeReport({ ...draft(), contextStatus: 'approved' })).toThrow(/context/i)
    expect(() => finalizeReport({
      ...draft(),
      contextStatus: 'declined',
      context: { status: 'available', data: { title: 'safe' } },
    })).toThrow(/context/i)
  })

  it('enforces field and section byte limits', () => {
    expect(() => finalizeReport({
      ...draft(),
      metadata: { logs: { status: 'available', data: { message: 'x'.repeat(20) } } },
    }, { maxFieldBytes: 10 })).toThrow(/field/i)
    expect(() => finalizeReport({
      ...draft(),
      metadata: { logs: { status: 'available', data: [{ message: 'safe' }, { message: 'safe' }] } },
    }, { maxSectionBytes: 10 })).toThrow(/section/i)
  })

  it('fails closed on forbidden output and total byte overflow', () => {
    expect(() => finalizeReport({
      ...draft(),
      metadata: { logs: { status: 'available', data: [{ value: 'password=super-secret-value' }] } },
    })).toThrow(/prohibited/i)
    expect(() => finalizeReport({
      ...draft(),
      metadata: { logs: { status: 'available', data: [{ value: 'x'.repeat(2_000) }] } },
    }, { maxTotalBytes: 100 })).toThrow(/limit/i)
  })

  it('supports report-specific standalone prohibited sentinels', () => {
    expect(() => finalizeReport({
      ...draft(),
      metadata: { logs: { status: 'available', data: [{ value: 'opaque-canary' }] } },
    }, { prohibitedValues: ['opaque-canary'] })).toThrow(/prohibited/i)
  })

  it('rejects malformed producer fields and unknown runtime section keys', () => {
    expect(() => finalizeReport({ ...draft(), reportId: '# bad\nheading' })).toThrow(/report id/i)
    expect(() => finalizeReport({ ...draft(), generatedAt: 'yesterday' })).toThrow(/generated/i)
    expect(() => finalizeReport({
      ...draft(),
      metadata: {
        ...draft().metadata,
        evil: { status: 'available', data: {} },
      } as never,
    })).toThrow(/section/i)
  })

  it('counts object keys against the field limit', () => {
    expect(() => finalizeReport({
      ...draft(),
      metadata: {
        logs: { status: 'available', data: { ['x'.repeat(30)]: 'safe' } },
      },
    }, { maxFieldBytes: 10 })).toThrow(/field/i)
  })

  it('rejects unsafe unavailable reason display strings', () => {
    expect(() => finalizeReport({
      ...draft(),
      metadata: {
        logs: { status: 'unavailable', reason: 'bad\n## injected' },
      },
    })).toThrow(/reason/i)
  })
})
