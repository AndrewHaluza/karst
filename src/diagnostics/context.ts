import type { Store } from '../store/db.js'
import { DIAGNOSTIC_LIMITS } from './limits.js'
import { sanitizeText } from './redact.js'
import type { DiagnosticSection, JsonValue } from './types.js'

interface ContextRow {
  title: string | null
  description: string | null
  brief: string | null
}

/**
 * Reads the narrowly disclosed, user-authored fields after the caller has
 * obtained consent for this report. This intentionally does not reuse the
 * launch-context renderer: commands, paths, artifacts, and prompts assembled
 * for an agent are outside the reporting consent boundary.
 */
export function collectApprovedContext(input: {
  readonly store: Store
  readonly projectId: number
  readonly ticketId: number
  readonly maxFieldBytes?: number
}): DiagnosticSection {
  const row = input.store.db.prepare(
    `SELECT title, description, brief
       FROM tickets
      WHERE id = ? AND project_id = ?`,
  ).get(input.ticketId, input.projectId) as ContextRow | undefined
  if (!row) {
    throw new Error(`ticket ${input.ticketId} does not belong to the current project`)
  }

  let omitted = 0
  const safe = (value: string | null): string | null => {
    if (value === null) return null
    const result = sanitizeText(value, {
      maxBytes: input.maxFieldBytes ?? DIAGNOSTIC_LIMITS.maxFieldBytes,
    })
    if (result.omitted) omitted++
    return result.value
  }
  const data = {
    title: safe(row.title),
    description: safe(row.description),
    brief: safe(row.brief),
  } satisfies JsonValue

  return omitted > 0
    ? { status: 'truncated', data, omitted, reason: 'bytes' }
    : { status: 'available', data }
}
