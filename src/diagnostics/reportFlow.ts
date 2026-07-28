import { finalizeReport } from './finalize.js'
import type {
  DiagnosticDraft,
  DiagnosticSection,
  FinalizedDiagnosticReport,
} from './types.js'

export type MetadataPreviewAction = 'continue' | 'refresh' | 'cancel'
export type ContextDecision = 'approve' | 'decline' | 'back' | undefined
export type FinalReviewAction =
  | 'copy'
  | 'save'
  | 'handoff'
  | 'remove-context'
  | 'refresh'
  | 'cancel'
export type ExportErrorAction = 'retry' | 'cancel'
export type ExportAction = 'copy' | 'save' | 'handoff'

export const CONTEXT_DISCLOSURE = Object.freeze({
  fields: ['title', 'description', 'brief'] as const,
  scope: 'this-report-only' as const,
})

export interface ReportFlowPorts<Selection> {
  select(): Promise<Selection | undefined>
  collectMetadata(selection: Selection): Promise<DiagnosticDraft>
  previewMetadata(draft: DiagnosticDraft): Promise<MetadataPreviewAction>
  decideContext(disclosure: typeof CONTEXT_DISCLOSURE): Promise<ContextDecision>
  collectContext(selection: Selection): Promise<DiagnosticSection>
  reviewFinal(snapshot: FinalizedDiagnosticReport): Promise<FinalReviewAction>
  copy(snapshot: FinalizedDiagnosticReport): Promise<void | 'cancelled'>
  save(snapshot: FinalizedDiagnosticReport): Promise<void | 'cancelled'>
  handoff(snapshot: FinalizedDiagnosticReport): Promise<void | 'cancelled'>
  onExportError(code: 'export_failed'): Promise<ExportErrorAction>
}

export type ReportFlowResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'exported'; readonly action: ExportAction }

function withDecision(
  draft: DiagnosticDraft,
  status: 'approved' | 'declined',
  context?: DiagnosticSection,
): DiagnosticDraft {
  return {
    ...draft,
    contextStatus: status,
    ...(context ? { context } : {}),
  }
}

async function exportSnapshot<Selection>(
  ports: ReportFlowPorts<Selection>,
  action: ExportAction,
  snapshot: FinalizedDiagnosticReport,
): Promise<'exported' | 'cancelled' | 'failed'> {
  for (;;) {
    try {
      const result = await ports[action](snapshot)
      return result === 'cancelled' ? 'cancelled' : 'exported'
    } catch {
      if (await ports.onExportError('export_failed') !== 'retry') return 'failed'
    }
  }
}

/**
 * Host-agnostic report state machine. Consent and snapshots live only on this
 * stack; refresh starts collection again and therefore has no remembered
 * approval. Exporters receive only the finalized object shown by final review.
 */
export async function runReportFlow<Selection>(
  ports: ReportFlowPorts<Selection>,
): Promise<ReportFlowResult> {
  const selection = await ports.select()
  if (selection === undefined) return { status: 'cancelled' }

  collection: for (;;) {
    const metadata = await ports.collectMetadata(selection)
    preview: for (;;) {
      const metadataAction = await ports.previewMetadata(metadata)
      if (metadataAction === 'cancel') return { status: 'cancelled' }
      if (metadataAction === 'refresh') continue collection

      const decision = await ports.decideContext(CONTEXT_DISCLOSURE)
      if (decision === undefined || decision === 'back') continue preview
      let decided: DiagnosticDraft
      if (decision === 'approve') {
        let context: DiagnosticSection
        try {
          context = await ports.collectContext(selection)
        } catch {
          context = { status: 'unavailable', reason: 'collector_failed' }
        }
        decided = withDecision(metadata, 'approved', context)
      } else {
        decided = withDecision(metadata, 'declined')
      }

      let snapshot = finalizeReport(decided)
      for (;;) {
        const action = await ports.reviewFinal(snapshot)
        if (action === 'cancel') return { status: 'cancelled' }
        if (action === 'refresh') continue collection
        if (action === 'remove-context') {
          snapshot = finalizeReport(withDecision(metadata, 'declined'))
          continue
        }
        const outcome = await exportSnapshot(ports, action, snapshot)
        if (outcome === 'cancelled') continue
        return outcome === 'exported'
          ? { status: 'exported', action }
          : { status: 'cancelled' }
      }
    }
  }
}
