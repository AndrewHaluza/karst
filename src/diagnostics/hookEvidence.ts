import { readFileSync } from 'node:fs'
import {
  HOOK_BRIDGE_OUTCOMES,
  HOOK_FAILURE_LOG_MAX_BYTES,
  bridgeOutcomeDetail,
  type HookBridgeOutcome,
} from '../agent/hookFailureLog.js'
import { normalizeHookEventName } from './hookChannel.js'

export interface HookFailureEntry {
  readonly at: string
  readonly event: string
  readonly outcome: string
}

export interface HookFailureEvidence {
  readonly entries: readonly HookFailureEntry[]
  readonly omitted: number
  /** Counts under the closed outcome vocabulary — a detail suffix folds onto its base. */
  readonly byOutcome: Readonly<Record<string, number>>
  /**
   * Counts of the exact validated outcomes, e.g. `http-error:404` or
   * `request-error:ECONNREFUSED`. Absent for records whose suffix failed
   * validation — those fold onto their base in `byOutcome` and are `unknown`
   * in the entries.
   */
  readonly byDetail: Readonly<Record<string, number>>
  readonly byEvent: Readonly<Record<string, number>>
  readonly oldestAt: string | null
  readonly newestAt: string | null
  /** Lines the bridge could not have written — a truncated tail or a foreign writer. */
  readonly unparsedLines: number
}

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>(HOOK_BRIDGE_OUTCOMES)

export const EMPTY_HOOK_FAILURE_EVIDENCE: HookFailureEvidence = Object.freeze({
  entries: [],
  omitted: 0,
  byOutcome: {},
  byDetail: {},
  byEvent: {},
  oldestAt: null,
  newestAt: null,
  unparsedLines: 0,
})

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString()
}

/**
 * Every field is re-validated against a closed vocabulary even though the bridge
 * authored the line: `event` originates in the agent's own payload (the bridge
 * only slices it to 64 chars) and the file is world-readable on disk. An
 * unrecognized outcome is counted as `unknown` rather than carried through —
 * unbounded prose must never reach a report the user pastes into a public issue.
 */
export function parseHookFailures(
  text: string,
  cap: number,
): HookFailureEvidence {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('Hook failure cap is invalid')
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const parsed: HookFailureEntry[] = []
  const detailCounts: Record<string, number> = {}
  let unparsedLines = 0
  for (const line of lines) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      unparsedLines += 1
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      unparsedLines += 1
      continue
    }
    const record = raw as Record<string, unknown>
    const at = isoOrNull(record.at)
    if (at === null) {
      unparsedLines += 1
      continue
    }
    const rawOutcome = typeof record.outcome === 'string' ? record.outcome : ''
    const parsedDetail = bridgeOutcomeDetail(rawOutcome)
    const outcome = KNOWN_OUTCOMES.has(rawOutcome)
      ? (rawOutcome as HookBridgeOutcome)
      : parsedDetail !== null
        ? parsedDetail.base
        : 'unknown'
    parsed.push({
      at,
      event: normalizeHookEventName(
        typeof record.event === 'string' ? record.event : undefined,
      ),
      outcome,
    })
    if (parsedDetail !== null) {
      detailCounts[rawOutcome] = (detailCounts[rawOutcome] ?? 0) + 1
    }
  }

  const byOutcome: Record<string, number> = {}
  const byEvent: Record<string, number> = {}
  for (const entry of parsed) {
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1
    byEvent[entry.event] = (byEvent[entry.event] ?? 0) + 1
  }

  // Totals cover every parsed line; only the verbatim entry list is capped, so a
  // long-running failure loop still reports its true magnitude.
  const kept = parsed.slice(Math.max(0, parsed.length - cap))
  return {
    entries: kept,
    omitted: parsed.length - kept.length,
    byOutcome,
    byDetail: detailCounts,
    byEvent,
    oldestAt: parsed[0]?.at ?? null,
    newestAt: parsed[parsed.length - 1]?.at ?? null,
    unparsedLines,
  }
}

export type ReadTextFile = (path: string) => string

/**
 * Read the bridge's failure log. A missing file is the normal state — most
 * sessions never fail a hook, and Claude sessions never write one at all — so it
 * is reported as absence, not as an error.
 */
export function readHookFailureLog(
  path: string,
  cap: number,
  readText: ReadTextFile = (target) => readFileSync(target, 'utf8'),
): { readonly present: boolean; readonly evidence: HookFailureEvidence } {
  let text: string
  try {
    text = readText(path)
  } catch {
    return { present: false, evidence: EMPTY_HOOK_FAILURE_EVIDENCE }
  }
  // The bridge stops appending at its own cap; a larger file means something
  // else wrote it, so only the tail within the contract is trusted.
  const bounded = Buffer.byteLength(text) > HOOK_FAILURE_LOG_MAX_BYTES
    ? text.slice(-HOOK_FAILURE_LOG_MAX_BYTES)
    : text
  return { present: true, evidence: parseHookFailures(bounded, cap) }
}
