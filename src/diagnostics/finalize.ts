import { createHash } from 'node:crypto'
import { DIAGNOSTIC_LIMITS } from './limits.js'
import { containsProhibitedSentinel, containsSensitiveValue } from './redact.js'
import { renderDiagnosticJson } from './renderJson.js'
import { renderDiagnosticMarkdown } from './renderMarkdown.js'
import type {
  DiagnosticDraft,
  DiagnosticReportV1,
  FinalizedDiagnosticReport,
} from './types.js'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function checksum(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

function assertStructuralLimits(
  report: DiagnosticReportV1,
  maxFieldBytes: number,
  maxSectionBytes: number,
): void {
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && Buffer.byteLength(value) > maxFieldBytes) {
      throw new Error('Diagnostic field exceeds the field byte limit')
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (Buffer.byteLength(key) > maxFieldBytes) {
          throw new Error('Diagnostic object key exceeds the field byte limit')
        }
        visit(child)
      }
    }
  }
  visit(report)
  for (const section of Object.values(report.metadata)) {
    if (section && Buffer.byteLength(JSON.stringify(section)) > maxSectionBytes) {
      throw new Error('Diagnostic section exceeds the section byte limit')
    }
  }
  if (report.context && Buffer.byteLength(JSON.stringify(report.context)) > maxSectionBytes) {
    throw new Error('Diagnostic context section exceeds the section byte limit')
  }
}

const SECTION_NAMES = new Set([
  'runtime',
  'ticket',
  'session',
  'stages',
  'gateRuns',
  'phaseMarks',
  'topology',
  'pullRequest',
  'effectiveConfig',
  'logs',
])

function assertProducerFields(draft: DiagnosticDraft): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(draft.reportId)) {
    throw new Error('Diagnostic report ID is invalid')
  }
  const timestamp = new Date(draft.generatedAt)
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== draft.generatedAt) {
    throw new Error('Diagnostic generated timestamp is invalid')
  }
  for (const [name, section] of Object.entries(draft.metadata)) {
    if (!SECTION_NAMES.has(name)) throw new Error(`Unknown diagnostic section: ${name}`)
    if (
      section?.status === 'unavailable'
      && !/^[a-z][a-z0-9_-]{0,63}$/.test(section.reason)
    ) {
      throw new Error(`Diagnostic unavailable reason is invalid for section: ${name}`)
    }
  }
  if (
    draft.context?.status === 'unavailable'
    && !/^[a-z][a-z0-9_-]{0,63}$/.test(draft.context.reason)
  ) {
    throw new Error('Diagnostic context unavailable reason is invalid')
  }
}

export function verifyFinalizedReport(value: FinalizedDiagnosticReport): boolean {
  return value.json === renderDiagnosticJson(value.report)
    && value.markdown === renderDiagnosticMarkdown(value.report)
    && value.checksum === checksum(value.markdown)
    && !containsSensitiveValue(value.json)
    && !containsSensitiveValue(value.markdown)
}

export function finalizeReport(
  draft: DiagnosticDraft,
  options: {
    readonly maxTotalBytes?: number
    readonly maxFieldBytes?: number
    readonly maxSectionBytes?: number
    readonly prohibitedValues?: readonly string[]
  } = {},
): FinalizedDiagnosticReport {
  assertProducerFields(draft)
  if ((draft.contextStatus === 'approved') !== (draft.context !== undefined)) {
    throw new Error('Approved context status and context section must be consistent')
  }
  const report = deepFreeze(structuredClone({
    ...draft,
    reportVersion: 1 as const,
  })) as DiagnosticReportV1
  assertStructuralLimits(
    report,
    options.maxFieldBytes ?? DIAGNOSTIC_LIMITS.maxFieldBytes,
    options.maxSectionBytes ?? DIAGNOSTIC_LIMITS.maxSectionBytes,
  )
  const json = renderDiagnosticJson(report)
  const markdown = renderDiagnosticMarkdown(report)
  if (
    containsSensitiveValue(json)
    || containsSensitiveValue(markdown)
    || containsProhibitedSentinel(json, options.prohibitedValues ?? [])
    || containsProhibitedSentinel(markdown, options.prohibitedValues ?? [])
  ) {
    throw new Error('Diagnostic output contains a prohibited sensitive value')
  }
  const maxBytes = options.maxTotalBytes ?? DIAGNOSTIC_LIMITS.maxTotalBytes
  if (Buffer.byteLength(json) > maxBytes || Buffer.byteLength(markdown) > maxBytes) {
    throw new Error('Diagnostic output exceeds the total byte limit')
  }
  const finalized = Object.freeze({
    report,
    json,
    markdown,
    checksum: checksum(markdown),
    exportJson: () => json,
    exportMarkdown: () => markdown,
  })
  if (!verifyFinalizedReport(finalized)) throw new Error('Final diagnostic verification failed')
  return finalized
}
