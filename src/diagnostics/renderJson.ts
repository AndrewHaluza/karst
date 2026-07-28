import type { DiagnosticReportV1, JsonValue } from './types.js'

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => stable(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

export function renderDiagnosticJson(report: DiagnosticReportV1): string {
  return `${JSON.stringify(stable(report as unknown as JsonValue), null, 2)}\n`
}

export function renderStableJsonValue(value: JsonValue): string {
  return JSON.stringify(stable(value), null, 2)
}
