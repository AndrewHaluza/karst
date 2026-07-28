import type { DiagnosticReportV1, DiagnosticSection } from './types.js'
import { renderDiagnosticJson, renderStableJsonValue } from './renderJson.js'

function fencedJson(value: string): string {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}json\n${value}\n${fence}`
}

function renderSection(name: string, section: DiagnosticSection): string {
  if (section.status === 'unavailable') {
    return `## ${name}\n\nStatus: unavailable (${section.reason})\n`
  }
  const qualifier = section.status === 'truncated'
    ? `truncated by ${section.reason} (${section.omitted} omitted)`
    : 'available'
  return `## ${name}\n\nStatus: ${qualifier}\n\n${fencedJson(renderStableJsonValue(section.data))}\n`
}

export function renderDiagnosticMarkdown(report: DiagnosticReportV1): string {
  const sections = Object.entries(report.metadata)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, section]) => renderSection(name, section))
  if (report.context) sections.push(renderSection('Optional context', report.context))
  return [
    '# Karst diagnostic report',
    '',
    `Report format: v${report.reportVersion}`,
    `Report ID: ${report.reportId}`,
    `Generated: ${report.generatedAt}`,
    `Context: ${report.contextStatus}`,
    '',
    '## Always excluded',
    '',
    ...report.exclusions.map(value => `- ${value}`),
    '',
    '## Redactions',
    '',
    fencedJson(renderStableJsonValue(report.redactions)),
    '',
    ...sections,
    '<details><summary>Canonical JSON</summary>',
    '',
    fencedJson(renderDiagnosticJson(report).trimEnd()),
    '',
    '</details>',
    '',
  ].join('\n')
}
