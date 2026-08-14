import type {
  DiagnosticSectionName,
  FinalizedDiagnosticReport,
  JsonValue,
} from './types.js'

/**
 * The operational half of an issue, filled in before the reporter types a word.
 *
 * A blank form produces the issue this ticket was raised about: a title, a
 * checksum, and no way to tell a Cursor-only defect from a VS Code one, or a
 * stale-schema report from a logic bug. Everything here is read back out of the
 * FINALIZED snapshot — the bytes the reporter already reviewed and that
 * `finalizeReport` proved carry no sensitive value — so prefilling adds no
 * disclosure the report itself did not already make. Nothing from the optional
 * session context is read: the prefill is operational only, whether or not the
 * reporter approved context for the attached report.
 */

/** GitHub truncates very long `?body=`; stay well inside what a URL survives. */
export const MAX_PREFILL_BODY_CHARS = 6_000

/** One table cell may not break the table or smuggle a wall of text into it. */
const MAX_CELL_CHARS = 120

export interface IssuePrefill {
  readonly title: string
  readonly body: string
  readonly truncated: boolean
}

type JsonObject = Readonly<Record<string, JsonValue>>

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function sectionData(
  snapshot: FinalizedDiagnosticReport,
  name: DiagnosticSectionName,
): JsonObject | null {
  const section = snapshot.report.metadata[name]
  if (!section || section.status === 'unavailable') return null
  return asObject(section.data)
}

function text(source: JsonObject | null, key: string): string | null {
  const value = source?.[key]
  if (typeof value === 'string') {
    // A cell is one line with no pipes: a value is data, never table structure.
    const collapsed = value.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()
    if (collapsed.length === 0) return null
    return collapsed.length > MAX_CELL_CHARS
      ? `${collapsed.slice(0, MAX_CELL_CHARS)}…`
      : collapsed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function counts(source: JsonObject | null, key: string): [string, number][] {
  const nested = asObject(source?.[key])
  if (!nested) return []
  return Object.entries(nested)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort(([a, left], [b, right]) => right - left || (a < b ? -1 : a > b ? 1 : 0))
}

function tally(entries: readonly [string, number][]): string {
  return entries.map(([name, count]) => `${name} ${count}`).join(', ')
}

/**
 * Group the validated outcome details (`byDetail`) under their base outcome, as
 * `[base, '404, 500']`. Only exact outcomes the bridge wrote with a validated
 * detail suffix appear; counts still come from the closed `byOutcome` tally.
 */
function detailGroups(source: JsonObject | null): [string, string][] {
  const byDetail = asObject(source?.['byDetail'])
  if (!byDetail) return []
  const groups = new Map<string, Set<string>>()
  for (const key of Object.keys(byDetail)) {
    const colon = key.indexOf(':')
    if (colon === -1) continue
    const base = key.slice(0, colon)
    const detail = key.slice(colon + 1)
    const set = groups.get(base) ?? new Set<string>()
    set.add(detail)
    groups.set(base, set)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([base, details]) => [base, [...details].sort().join(', ')] as [string, string])
}

function joinDefined(parts: readonly (string | null)[], separator: string): string | null {
  const kept = parts.filter((part): part is string => part !== null && part.length > 0)
  return kept.length > 0 ? kept.join(separator) : null
}

function flag(source: JsonObject | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : null
}

function row(field: string, value: string | null): string | null {
  return value === null ? null : `| ${field} | ${value} |`
}

function environmentRows(snapshot: FinalizedDiagnosticReport): string[] {
  const runtime = sectionData(snapshot, 'runtime')
  const config = sectionData(snapshot, 'effectiveConfig')
  const ticket = sectionData(snapshot, 'ticket')
  const registry = sectionData(snapshot, 'registry')
  const editor = joinDefined(
    [
      joinDefined([text(runtime, 'appName'), text(runtime, 'editorVersion')], ' '),
      text(runtime, 'uiKind'),
      text(runtime, 'appHost'),
    ],
    ' · ',
  )
  const runtimeStack = joinDefined(
    [
      text(runtime, 'nodeVersion') && `Node ${text(runtime, 'nodeVersion')}`,
      text(runtime, 'electronVersion') && `Electron ${text(runtime, 'electronVersion')}`,
      text(runtime, 'nodeAbi') && `ABI ${text(runtime, 'nodeAbi')}`,
    ],
    ' · ',
  )
  const schema = text(registry, 'schemaVersion')
  const expected = text(registry, 'expectedSchemaVersion')
  return [
    row('Karst', text(runtime, 'extensionVersion')),
    row('Editor', editor),
    row('Platform', joinDefined(
      [text(runtime, 'platform'), text(runtime, 'arch')],
      ' ',
    )),
    row('Runtime', runtimeStack),
    row('Remote workspace', flag(runtime, 'remoteNamePresent')),
    row('Development build', flag(runtime, 'developmentMode')),
    row('Agent', joinDefined(
      [
        text(ticket, 'resolvedProvider') ?? text(config, 'agentProvider'),
        text(ticket, 'resolvedModel') ?? text(config, 'resolvedModel'),
      ],
      ' · ',
    )),
    row('Ticketing', text(config, 'ticketingProvider')),
    row('Stage', joinDefined(
      [text(ticket, 'currentStage'), text(ticket, 'agentState')],
      ' · ',
    )),
    row('Registry schema', schema === null
      ? null
      : expected === null || schema === expected
        ? `v${schema}`
        : `v${schema} (expected v${expected})`),
  ].filter((line): line is string => line !== null)
}

/**
 * The hook lines exist because the agent's own message — `PostToolUse hook
 * (failed): hook exited with code 1` — names neither the event's fate nor the
 * status that caused it. Both counters go in the prefilled body, so an issue
 * about hooks arrives already saying which side dropped the request.
 */
export function hookLines(snapshot: FinalizedDiagnosticReport): string[] {
  const hooks = sectionData(snapshot, 'hooks')
  if (!hooks) return []
  const lines: string[] = []
  const channel = asObject(hooks.channel)
  if (channel) {
    const outcomes = tally(counts(channel, 'outcomes'))
    lines.push(
      `- Endpoint: ${text(channel, 'requests') ?? '0'} request(s)`
        + (outcomes ? ` — ${outcomes}` : ''),
    )
  }
  const bridge = asObject(hooks.bridge)
  if (bridge?.present === true) {
    // The detail groups name the status/code the hook exited on (`http-error
    // 2 (404, 500)` instead of a bare `http-error 2` count) — the agent's own
    // message only ever says `hook exited with code 1`.
    const groups = detailGroups(bridge)
    const outcomes = groups.length > 0
      ? groups
        .map(([base, details]) => {
          const byBase = asObject(bridge['byOutcome'])
          const count =
            byBase !== null && typeof byBase[base] === 'number'
              ? (byBase[base] as number)
              : 0
          return `${base} ${count} (${details})`
        })
        .join(', ')
      : tally(counts(bridge, 'byOutcome'))
    const newest = text(bridge, 'newestAt')
    lines.push(
      `- Codex bridge: ${text(bridge, 'failures') ?? '0'} failure(s)`
        + (outcomes ? ` — ${outcomes}` : '')
        + (newest ? ` (newest ${newest})` : ''),
    )
  }
  return lines.length > 0 ? lines : []
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * One line naming every agent core the ticket actually used, read from the
 * append-only `cores` section — a mid-session core switch leaves both cores
 * visible, which is the point: the report used to carry only the codex bridge.
 * Absent/unavailable section reads as no line, like the hook lines.
 */
export function coreLines(snapshot: FinalizedDiagnosticReport): string[] {
  const section = snapshot.report.metadata.cores
  if (!section || section.status === 'unavailable') return []
  if (!Array.isArray(section.data)) return []
  const parts: string[] = []
  for (const row of section.data) {
    const value = row as Readonly<Record<string, JsonValue>>
    const core = typeof value.core === 'string' ? value.core : null
    if (core === null) continue
    const headless = typeof value.headlessCalls === 'number' ? value.headlessCalls : 0
    const interactive = typeof value.interactiveCalls === 'number' ? value.interactiveCalls : 0
    const sessions = typeof value.sessions === 'number' ? value.sessions : 0
    // FRESH spend headlines the line, cache reads follow it — the same split
    // every other surface makes. A raw tally here reads as a runaway agent on
    // an ordinary cached session and sends the reader after the wrong problem.
    const tokens = asObject(value.headlessTokens)
    const rawTotal = typeof tokens?.total === 'number' ? tokens.total : null
    const cacheRead = typeof tokens?.cacheRead === 'number' ? tokens.cacheRead : 0
    const tokenTotal = rawTotal === null ? null : formatTokens(Math.max(0, rawTotal - cacheRead))
    const bits = [
      ...(headless > 0 ? [`${headless} headless`] : []),
      ...(interactive > 0 ? [`${interactive} interactive`] : []),
      ...(sessions > 0 ? [`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`] : []),
      ...(tokenTotal !== null && tokenTotal !== '0' ? [`${tokenTotal} tokens`] : []),
      ...(cacheRead > 0 ? [`${formatTokens(cacheRead)} cache read`] : []),
    ]
    if (bits.length > 0) parts.push(`${core} (${bits.join(' · ')})`)
  }
  return parts.length > 0 ? [`- Cores used: ${parts.join(', ')}`] : []
}

function noticeLines(snapshot: FinalizedDiagnosticReport): string[] {
  const notices = Object.entries(snapshot.report.metadata).flatMap(([name, section]) => {
    if (section?.status === 'truncated') {
      return [`${name} truncated (${section.omitted} omitted by ${section.reason})`]
    }
    return section?.status === 'unavailable' ? [`${name} unavailable (${section.reason})`] : []
  })
  const redactions = Object.entries(snapshot.report.redactions)
    .map(([category, count]) => `${category} ${count}`)
  return [
    ...(notices.length > 0 ? [`- Section notices: ${notices.join(', ')}`] : []),
    `- Redactions: ${redactions.length > 0 ? redactions.join(', ') : 'none'}`,
  ]
}

export function buildIssuePrefill(
  snapshot: FinalizedDiagnosticReport,
  extensionVersion: string,
): IssuePrefill {
  const hooks = hookLines(snapshot)
  const cores = coreLines(snapshot)
  const environment = environmentRows(snapshot)
  const body = [
    '### What happened',
    '',
    '<!-- What you did, what you expected, and what happened instead. -->',
    '',
    // A collector that failed leaves no table at all rather than an empty one.
    ...(environment.length > 0
      ? ['### Environment', '', '| Field | Value |', '| --- | --- |', ...environment, '']
      : []),
    ...(hooks.length > 0 ? ['### Hook channel', '', ...hooks, ''] : []),
    ...(cores.length > 0 ? ['### Agent cores', '', ...cores, ''] : []),
    '### Diagnostic report',
    '',
    `- Report reference: ${snapshot.report.reportId}`,
    `- Report schema: v${snapshot.report.reportVersion}`,
    `- Generated: ${snapshot.report.generatedAt}`,
    `- Session context: ${snapshot.report.contextStatus}`,
    `- Checksum: ${snapshot.checksum}`,
    ...noticeLines(snapshot),
    '',
    'Karst did not upload diagnostics. After reviewing this form, paste or attach the '
      + 'diagnostic report and submit the issue in GitHub.',
    '',
  ].join('\n')
  const truncated = body.length > MAX_PREFILL_BODY_CHARS
  return {
    // `extensionVersion` comes from the host rather than the snapshot so the
    // title is right even when the runtime section could not be collected.
    title: `[Karst ${extensionVersion}] `,
    body: truncated
      ? `${body.slice(0, MAX_PREFILL_BODY_CHARS)}\n\n_(prefill truncated — the attached report is complete)_`
      : body,
    truncated,
  }
}
