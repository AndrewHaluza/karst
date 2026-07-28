import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticDraft, FinalizedDiagnosticReport } from './types.js'
import { runReportFlow, type ReportFlowPorts } from './reportFlow.js'

type Selection = { ticketId: number }

function draft(reportId: string): DiagnosticDraft {
  return {
    reportId,
    generatedAt: '2026-07-28T00:00:00.000Z',
    contextStatus: 'not-requested',
    metadata: { runtime: { status: 'available', data: { revision: reportId } } },
    exclusions: ['secrets'],
    redactions: {},
  }
}

function ports(overrides: Partial<ReportFlowPorts<Selection>> = {}) {
  const events: string[] = []
  const exported: FinalizedDiagnosticReport[] = []
  let report = 0
  const value: ReportFlowPorts<Selection> = {
    select: async () => {
      events.push('select')
      return { ticketId: 1 }
    },
    collectMetadata: async () => {
      events.push('collect-metadata')
      return draft(`report-${++report}`)
    },
    previewMetadata: async () => {
      events.push('preview-metadata')
      return 'continue'
    },
    decideContext: async () => {
      events.push('decide-context')
      return 'decline'
    },
    collectContext: async () => {
      events.push('collect-context')
      return { status: 'available', data: { title: 'approved title' } }
    },
    reviewFinal: async () => {
      events.push('review-final')
      return 'copy'
    },
    copy: async (snapshot) => {
      events.push('copy')
      exported.push(snapshot)
    },
    save: async (snapshot) => {
      events.push('save')
      exported.push(snapshot)
    },
    handoff: async (snapshot) => {
      events.push('handoff')
      exported.push(snapshot)
    },
    onExportError: async () => 'cancel',
    ...overrides,
  }
  return { value, events, exported }
}

describe('runReportFlow', () => {
  it('declines context and still exports the exact reviewed snapshot', async () => {
    let reviewed: FinalizedDiagnosticReport | undefined
    const harness = ports({
      decideContext: async () => 'decline',
      reviewFinal: async (snapshot) => {
        reviewed = snapshot
        return 'save'
      },
    })
    expect(await runReportFlow(harness.value)).toEqual({ status: 'exported', action: 'save' })
    expect(harness.exported).toEqual([reviewed])
    expect(reviewed?.report.contextStatus).toBe('declined')
    expect(harness.events).toEqual([
      'select', 'collect-metadata', 'preview-metadata',
      'save',
    ])
  })

  it('treats dismissed context choice as Back and a cancelled Save as neutral', async () => {
    let decisions = 0
    let reviews = 0
    const collectMetadata = vi.fn(async () => draft('stable'))
    const save = vi.fn()
      .mockResolvedValueOnce('cancelled')
      .mockResolvedValueOnce(undefined)
    const harness = ports({
      decideContext: async () => (++decisions === 1 ? undefined : 'decline'),
      collectMetadata,
      reviewFinal: async () => {
        reviews++
        return 'save'
      },
      save,
    })
    expect(await runReportFlow(harness.value)).toEqual({ status: 'exported', action: 'save' })
    expect(decisions).toBe(2)
    expect(collectMetadata).toHaveBeenCalledTimes(1)
    expect(reviews).toBe(2)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('requires fresh consent after refresh and freezes source values before export', async () => {
    const decisions = vi.fn()
      .mockResolvedValueOnce('approve')
      .mockResolvedValueOnce('decline')
    const reviews: Array<FinalizedDiagnosticReport> = []
    let metadata = draft('source')
    let reviewsSeen = 0
    const harness = ports({
      collectMetadata: async () => metadata,
      decideContext: decisions,
      reviewFinal: async (snapshot) => {
        reviews.push(snapshot)
        reviewsSeen++
        if (reviewsSeen === 1) return 'refresh'
        ;(metadata.metadata.runtime as unknown as {
          data: { revision: string }
        }).data.revision = 'mutated'
        return 'copy'
      },
    })
    await runReportFlow(harness.value)
    expect(decisions).toHaveBeenCalledTimes(2)
    expect(reviews.map((item) => item.report.contextStatus)).toEqual(['approved', 'declined'])
    expect(reviews[1]?.markdown).not.toContain('mutated')
    expect(harness.exported[0]).toBe(reviews[1])
  })

  it('removes context by refinalizing without recollecting or asking again', async () => {
    const collectContext = vi.fn(async () => ({
      status: 'available' as const,
      data: { title: 'approved title' },
    }))
    const decideContext = vi.fn(async () => 'approve' as const)
    const reviewed: FinalizedDiagnosticReport[] = []
    const harness = ports({
      collectContext,
      decideContext,
      reviewFinal: vi.fn(async (snapshot) => {
        reviewed.push(snapshot)
        return reviewed.length === 1 ? 'remove-context' : 'handoff'
      }),
    })
    await runReportFlow(harness.value)
    expect(decideContext).toHaveBeenCalledTimes(1)
    expect(collectContext).toHaveBeenCalledTimes(1)
    expect(reviewed.map((item) => item.report.contextStatus)).toEqual(['approved', 'declined'])
    expect(reviewed[0]).not.toBe(reviewed[1])
    expect(harness.exported[0]).toBe(reviewed[1])
  })

  it('cancels without exporting and retries exporter failures without leaking errors', async () => {
    const cancelled = ports({ reviewFinal: async () => 'cancel' })
    expect(await runReportFlow(cancelled.value)).toEqual({ status: 'cancelled' })
    expect(cancelled.exported).toEqual([])

    const rawError = new Error('PRIVATE_EXPORT_FAILURE')
    const copy = vi.fn()
      .mockRejectedValueOnce(rawError)
      .mockResolvedValueOnce(undefined)
    const onExportError = vi.fn(async () => 'retry' as const)
    const retry = ports({ copy, onExportError })
    expect(await runReportFlow(retry.value)).toEqual({ status: 'exported', action: 'copy' })
    expect(copy).toHaveBeenCalledTimes(2)
    expect(copy.mock.calls[0]?.[0]).toBe(copy.mock.calls[1]?.[0])
    expect(onExportError).toHaveBeenCalledWith('export_failed')
    expect(JSON.stringify(onExportError.mock.calls)).not.toContain('PRIVATE_EXPORT_FAILURE')
  })
})
