import { SCHEMA_VERSION } from '../store/migrations.js'
import type { Store } from '../store/db.js'
import type { HookChannelSnapshot } from './hookChannel.js'
import { readHookFailureLog, type ReadTextFile } from './hookEvidence.js'
import type { DiagnosticSection, JsonValue } from './types.js'

export type SafeText = (value: string | null) => string | null

function json(value: unknown): JsonValue {
  return value as JsonValue
}

function available(value: unknown): DiagnosticSection {
  return { status: 'available', data: json(value) }
}

export interface RuntimeDiagnosticInput {
  readonly extensionVersion: string
  readonly editorVersion: string
  readonly platform: string
  readonly arch: string
  readonly remoteNamePresent: boolean
  readonly uiKind: string
  readonly developmentMode: boolean
  /**
   * The rest describes the process the extension host is actually running in.
   * `nodeVersion`/`electronVersion`/`nodeAbi` are here because the native
   * `better-sqlite3` addon is loaded by ABI: a mismatch is a whole class of
   * report ("nothing works after an editor update") that is unanswerable
   * without the three numbers. `appName` distinguishes the forks that all
   * report a `vscode.version` — a Cursor-only defect looks like a VS Code
   * defect otherwise.
   */
  readonly appName?: string
  readonly appHost?: string
  readonly language?: string
  readonly nodeVersion?: string
  readonly electronVersion?: string | null
  readonly nodeAbi?: string
  /** Milliseconds since the extension activated — separates cold-start bugs from drift. */
  readonly uptimeMs?: number
}

export function runtimeSection(
  runtime: RuntimeDiagnosticInput,
  safe: SafeText,
): DiagnosticSection {
  return available({
    extensionVersion: safe(runtime.extensionVersion),
    editorVersion: safe(runtime.editorVersion),
    appName: safe(runtime.appName ?? null),
    appHost: safe(runtime.appHost ?? null),
    language: safe(runtime.language ?? null),
    platform: safe(runtime.platform),
    arch: safe(runtime.arch),
    nodeVersion: safe(runtime.nodeVersion ?? null),
    electronVersion: safe(runtime.electronVersion ?? null),
    nodeAbi: safe(runtime.nodeAbi ?? null),
    remoteNamePresent: runtime.remoteNamePresent,
    uiKind: safe(runtime.uiKind),
    developmentMode: runtime.developmentMode,
    uptimeMs: runtime.uptimeMs ?? null,
  })
}

export interface HookDiagnosticInput {
  /** Counters for this activation's endpoint; absent when no channel is bound. */
  readonly channel?: HookChannelSnapshot
  /** Where the Codex bridge appends its own failures; absent for other cores. */
  readonly failureLogPath?: string
  readonly readText?: ReadTextFile
}

/**
 * Both halves of one story.
 *
 * `PostToolUse hook (failed) — hook exited with code 1` is everything the agent
 * says. `bridge` is what the failing side recorded (why it exited); `channel`
 * is what the endpoint saw (whether the request even arrived, and with what
 * status). Either alone is a guess — a 404 count next to an `http-error` count
 * names a stale port; an `http-error` count with no matching request says the
 * agent is posting somewhere else entirely.
 */
export function hooksSection(
  input: HookDiagnosticInput,
  cap: number,
): DiagnosticSection {
  try {
    const bridge = input.failureLogPath === undefined
      ? null
      : readHookFailureLog(input.failureLogPath, cap, input.readText)
    const data = {
      channel: input.channel
        ? {
          requests: input.channel.total,
          outcomes: input.channel.outcomes,
          events: input.channel.events,
          firstAt: input.channel.firstAt,
          lastAt: input.channel.lastAt,
        }
        : null,
      bridge: bridge === null || !bridge.present
        ? { present: false }
        : {
          present: true,
          failures: bridge.evidence.entries.length + bridge.evidence.omitted,
          byOutcome: bridge.evidence.byOutcome,
          byEvent: bridge.evidence.byEvent,
          oldestAt: bridge.evidence.oldestAt,
          newestAt: bridge.evidence.newestAt,
          unparsedLines: bridge.evidence.unparsedLines,
          recent: bridge.evidence.entries,
        },
    }
    const omitted = bridge?.evidence.omitted ?? 0
    return omitted > 0
      ? { status: 'truncated', data: json(data), omitted, reason: 'rows' }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}

const COUNTED_TABLES = [
  'projects',
  'tickets',
  'worktrees',
  'servers',
  'stages',
  'gate_runs',
  'phase_marks',
  'prs',
  'merge_checks',
] as const

function countRows(store: Store, table: string): number | null {
  try {
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n: number }
      | undefined
    return row?.n ?? null
  } catch {
    // A table this build does not have yet is a fact about the registry, not a
    // collection failure — the version below is what explains it.
    return null
  }
}

/**
 * Registry shape, not registry content.
 *
 * The version pair is the point: the CLI refuses to run below `SCHEMA_VERSION`
 * and the extension is the only thing that migrates, so "opened a stale DB"
 * and "migration did not run" are indistinguishable in a report that omits it.
 * The row counts are magnitudes only — they say whether a board has 4 tickets
 * or 4000, which is the difference between a logic bug and a scale one.
 */
export function registrySection(
  store: Store,
  projectId: number | null,
): DiagnosticSection {
  try {
    const version = store.db.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined
    const schemaVersion = version?.user_version ?? null
    const counts: Record<string, number | null> = {}
    for (const table of COUNTED_TABLES) counts[table] = countRows(store, table)
    let ticketsInProject: number | null = null
    if (projectId !== null) {
      try {
        const row = store.db.prepare(
          'SELECT COUNT(*) AS n FROM tickets WHERE project_id = ?',
        ).get(projectId) as { n: number } | undefined
        ticketsInProject = row?.n ?? null
      } catch {
        ticketsInProject = null
      }
    }
    return available({
      schemaVersion,
      expectedSchemaVersion: SCHEMA_VERSION,
      migrated: schemaVersion !== null && schemaVersion >= SCHEMA_VERSION,
      ticketsInProject,
      rowCounts: counts,
    })
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}
