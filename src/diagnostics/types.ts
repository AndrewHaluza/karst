export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type DiagnosticSection<T extends JsonValue = JsonValue> =
  | { readonly status: 'available'; readonly data: T }
  | {
    readonly status: 'truncated'
    readonly data: T
    readonly omitted: number
    readonly reason: 'rows' | 'age' | 'bytes'
  }
  | { readonly status: 'unavailable'; readonly reason: string }

export type DiagnosticContextStatus = 'not-requested' | 'declined' | 'approved'
export type DiagnosticSectionName =
  | 'runtime'
  | 'ticket'
  | 'session'
  | 'stages'
  | 'gateRuns'
  | 'phaseMarks'
  | 'graph'
  | 'cores'
  | 'topology'
  | 'pullRequest'
  | 'effectiveConfig'
  | 'hooks'
  | 'registry'
  | 'logs'
export type DiagnosticSections = Readonly<
  Partial<Record<DiagnosticSectionName, DiagnosticSection>>
>

export interface DiagnosticDraft {
  readonly reportId: string
  readonly generatedAt: string
  readonly contextStatus: DiagnosticContextStatus
  readonly metadata: DiagnosticSections
  readonly context?: DiagnosticSection
  readonly exclusions: readonly string[]
  readonly redactions: Readonly<Record<string, number>>
}

export interface DiagnosticReportV1 extends DiagnosticDraft {
  readonly reportVersion: 1
}

export interface FinalizedDiagnosticReport {
  readonly report: DiagnosticReportV1
  readonly json: string
  readonly markdown: string
  readonly checksum: string
  exportJson(): string
  exportMarkdown(): string
}
