import { resolveModelForProvider } from '../agent/models.js'
import { resolvePresetDefaults } from '../agent/agentPresets.js'
import type { LogBuffer, LogEntry, LogLevel } from '../logging/logger.js'
import type { Manifest } from '../manifest/types.js'
import type { Store } from '../store/db.js'
import type { Project } from '../store/projects.js'
import { DIAGNOSTIC_LIMITS } from './limits.js'
import { isEvidenceMessage, ticketPatternFor } from './logEvidence.js'
import { projectEffectiveConfig } from './projectConfig.js'
import type { Pseudonymizer } from './pseudonymize.js'
import { sanitizeText } from './redact.js'
import { createRepositoryAliases, type RepositoryAliases } from './repositoryAliases.js'
import {
  hooksSection,
  registrySection,
  runtimeSection,
  type HookDiagnosticInput,
  type RuntimeDiagnosticInput,
} from './hostEvidence.js'
import {
  readCoreUsage,
  readGateRuns,
  readGraphRuns,
  readMergeChecks,
  readNodeRuns,
  readPhaseMarks,
  readPlannerRuns,
  readPullRequests,
  readServers,
  readStages,
  readWorktrees,
  type BoundedRows,
} from './storeEvidence.js'
import type {
  DiagnosticDraft,
  DiagnosticSection,
  DiagnosticSectionName,
  JsonValue,
} from './types.js'

export type { RuntimeDiagnosticInput } from './hostEvidence.js'

export interface MetadataSources {
  readonly store: Store
  readonly project: Project
  readonly manifest: Manifest
  readonly ticketId: number
  readonly runtime: RuntimeDiagnosticInput
  readonly logs: LogBuffer
  readonly reportId: string
  readonly generatedAt: string
  readonly aliases: Pseudonymizer
  /** Hook-channel counters and the Codex bridge's own failure log. */
  readonly hooks?: HookDiagnosticInput
  /** Polled at every yield point so a cancel click stops the read sequence. */
  readonly isCancelled?: () => boolean
}

/** Raised when the caller cancelled collection; carries no diagnostic data. */
export class CollectionCancelledError extends Error {
  constructor() {
    super('collection_cancelled')
    this.name = 'CollectionCancelledError'
  }
}

interface DiagnosticTicketRow {
  id: number
  key: string | null
  source: string | null
  stage_current: string | null
  agent_state: string | null
  session_id: string | null
  approach: string | null
  agent: string | null
  selected_repos: string | null
  archived_at: string | null
  model: string | null
  agent_provider: 'claude' | 'codex' | 'antigravity' | 'opencode' | null
  agent_preset: string | null
  session_provider: 'claude' | 'codex' | 'antigravity' | 'opencode' | null
}

function json(value: unknown): JsonValue {
  return value as JsonValue
}

function available(value: unknown): DiagnosticSection {
  return { status: 'available', data: json(value) }
}

function section<T>(result: BoundedRows<T>, data: unknown): DiagnosticSection {
  return result.omitted > 0
    ? {
      status: 'truncated',
      data: json(data),
      omitted: result.omitted,
      reason: 'rows',
    }
    : available(data)
}

/**
 * Yield to the extension host, then honour cancellation. The yield points are
 * the only interruption opportunities collection has — each individual read is
 * bounded and synchronous — so the cancel check belongs here rather than only
 * at the entry and exit of the whole sequence.
 */
async function yieldToHost(isCancelled?: () => boolean): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (isCancelled?.()) throw new CollectionCancelledError()
}

/** Stands in for a value the sanitizer refused to emit. */
const OMITTED_VALUE = '[OMITTED:unsafe-metadata]'

/**
 * Sanitize a metadata value, accumulating what was removed into `redactions`.
 *
 * A dropped value renders as `OMITTED_VALUE`, never `null`: `null` is what an
 * unset column already looks like, and the `nul` / `input-too-large` paths
 * report no redaction category, so a silent `null` would erase every trace that
 * something was removed. The omissions are counted under `omitted` so the
 * review summary states them alongside the per-category counts.
 */
function makeSafeText(
  redactions: Record<string, number>,
): (value: string | null) => string | null {
  return (value) => {
    if (value === null) return null
    const sanitized = sanitizeText(value)
    for (const [category, count] of Object.entries(sanitized.counts)) {
      if (category !== 'total') redactions[category] = (redactions[category] ?? 0) + count
    }
    if (sanitized.value === null) {
      redactions.omitted = (redactions.omitted ?? 0) + 1
      return OMITTED_VALUE
    }
    return sanitized.value
  }
}

/** First-seen order, no repeats — a monorepo's entries appear once each. */
function dedup(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function selectedRepos(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export async function collectMetadata(input: MetadataSources): Promise<DiagnosticDraft> {
  // Collection is user-driven but may walk the maximum bounded evidence set.
  // Yield once before SQLite work so command invocation never monopolizes the
  // extension host in the same turn as the UI event that requested the report.
  await yieldToHost(input.isCancelled)
  const owner = input.store.db.prepare(
    'SELECT project_id FROM tickets WHERE id = ?',
  ).get(input.ticketId) as { project_id: number | null } | undefined
  if (!owner) throw new Error(`ticket ${input.ticketId} not found`)
  if (owner.project_id !== input.project.id) {
    throw new Error(`ticket ${input.ticketId} does not belong to the current project`)
  }

  const ticket = input.store.db.prepare(
    `SELECT id, key, source, stage_current, agent_state, session_id, approach, agent,
            selected_repos, archived_at, model, agent_provider, agent_preset, session_provider
       FROM tickets
      WHERE id = ? AND project_id = ?`,
  ).get(input.ticketId, input.project.id) as DiagnosticTicketRow
  const redactions: Record<string, number> = {}
  const safe = makeSafeText(redactions)
  const repositoryNames = selectedRepos(ticket.selected_repos)
  const repositories = createRepositoryAliases(input.manifest)
  const defaults = resolvePresetDefaults(input.manifest, 'implementation', {
    ticketPreset: ticket.agent_preset,
    explicitProvider: ticket.agent_provider,
  })
  const provider = defaults.provider
  const model = resolveModelForProvider(provider, ticket.model, defaults.model)
  const mapRepositories = (values: readonly string[]): string[] =>
    values.map(repositories.byName)

  const metadata: Partial<Record<DiagnosticSectionName, DiagnosticSection>> = {
    runtime: runtimeSection(input.runtime, safe),
    registry: registrySection(input.store, input.project.id),
    hooks: hooksSection(input.hooks ?? {}, DIAGNOSTIC_LIMITS.maxHookFailures),
    ticket: available({
      ticketRef: input.aliases.ticket(String(ticket.id)),
      keyRef: ticket.key ? input.aliases.ticket(ticket.key) : null,
      source: safe(ticket.source),
      currentStage: safe(ticket.stage_current),
      agentState: safe(ticket.agent_state),
      approach: safe(ticket.approach),
      agentRole: safe(ticket.agent),
      repositories: mapRepositories(repositoryNames),
      archived: ticket.archived_at !== null,
      resolvedModel: safe(model ?? null),
      resolvedProvider: provider,
    }),
    session: available({
      sessionRef: ticket.session_id ? input.aliases.session(ticket.session_id) : null,
      provider: ticket.session_provider,
      present: ticket.session_id !== null,
    }),
    effectiveConfig: available(projectEffectiveConfig(input.manifest, {
      projectIdentity: input.manifest.id ?? input.project.slug,
      selectedRepos: repositoryNames,
      selectedApproach: ticket.approach,
      resolvedModel: model,
      resolvedProvider: provider,
      aliases: input.aliases,
      repositoryAlias: repositories.byName,
    })),
  }

  try {
    const result = readStages(input.store, input.ticketId, DIAGNOSTIC_LIMITS.maxRowsPerSection)
    metadata.stages = section(result, result.rows.map((stage) => ({
      stage: safe(stage.stageKey),
      status: safe(stage.status),
      attempt: stage.attempt,
      verdict: safe(stage.verdict),
      hasArtifact: stage.hasArtifact,
      startedAt: safe(stage.startedAt),
      endedAt: safe(stage.endedAt),
    })))
  } catch {
    metadata.stages = { status: 'unavailable', reason: 'reader_failed' }
  }

  await yieldToHost(input.isCancelled)
  try {
    const result = readGateRuns(input.store, input.ticketId, DIAGNOSTIC_LIMITS.maxRowsPerSection)
    metadata.gateRuns = section(result, result.rows.map((row, index) => ({
      sequence: index + 1,
      stage: safe(row.stageKey),
      attempt: row.attempt,
      runAt: row.runAt,
      gate: safe(row.gateName),
      exitCode: row.exitCode,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    })))
  } catch {
    metadata.gateRuns = { status: 'unavailable', reason: 'reader_failed' }
  }

  await yieldToHost(input.isCancelled)
  try {
    const result = readPhaseMarks(input.store, input.ticketId, DIAGNOSTIC_LIMITS.maxRowsPerSection)
    metadata.phaseMarks = section(result, result.rows.map((row, index) => ({
      sequence: index + 1,
      stage: safe(row.stageKey),
      attempt: row.attempt,
      phase: safe(row.phaseName),
      markedAt: row.markedAt,
    })))
  } catch {
    metadata.phaseMarks = { status: 'unavailable', reason: 'reader_failed' }
  }

  await yieldToHost(input.isCancelled)
  metadata.graph = collectGraph(input, safe)
  await yieldToHost(input.isCancelled)
  metadata.topology = collectTopology(input, safe, repositories)
  await yieldToHost(input.isCancelled)
  metadata.pullRequest = collectPullRequests(input, safe, repositories)
  await yieldToHost(input.isCancelled)
  metadata.cores = collectCores(input, safe)
  await yieldToHost(input.isCancelled)
  metadata.logs = collectLogs(input.logs.snapshot(), input.generatedAt, safe, input.ticketId)

  return {
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    contextStatus: 'not-requested',
    metadata,
    exclusions: [
      'credentials, tokens, private keys, environment and SecretStorage',
      'session transcripts, prompts, repository files and stage artifacts',
      'raw paths, commands, URLs, host addresses and unrelated project data',
    ],
    redactions,
  }
}

/** Metadata-only extension report used when no ticket is applicable. */
export async function collectProjectMetadata(
  input: Omit<MetadataSources, 'ticketId'>,
): Promise<DiagnosticDraft> {
  await yieldToHost(input.isCancelled)
  const redactions: Record<string, number> = {}
  const safe = makeSafeText(redactions)
  const aliases = createRepositoryAliases(input.manifest)
  const repositories = Object.keys(input.manifest.repositories)
  const projectDefaults = resolvePresetDefaults(input.manifest, 'implementation')
  return {
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    contextStatus: 'not-requested',
    metadata: {
      runtime: runtimeSection(input.runtime, safe),
      registry: registrySection(input.store, input.project.id),
      hooks: hooksSection(input.hooks ?? {}, DIAGNOSTIC_LIMITS.maxHookFailures),
      effectiveConfig: available(projectEffectiveConfig(input.manifest, {
        projectIdentity: input.manifest.id ?? input.project.slug,
        selectedRepos: repositories,
        selectedApproach: null,
        resolvedModel: projectDefaults.model,
        resolvedProvider: projectDefaults.provider,
        aliases: input.aliases,
        repositoryAlias: aliases.byName,
      })),
      cores: collectProjectCores(input, safe),
      logs: collectLogs(input.logs.snapshot(), input.generatedAt, safe, null),
    },
    exclusions: [
      'credentials, tokens, private keys, environment and SecretStorage',
      'ticket and session context, transcripts, prompts, repository files and stage artifacts',
      'raw paths, commands, URLs, host addresses and unrelated project data',
    ],
    redactions,
  }
}

/**
 * The graph subsystem that owns the ticket's `impl` stage (G6,
 * `docs/arch/graph-run-reliability.md`). Read-only, ticket-scoped: graph runs,
 * their planner runs and node runs, and each run's active revision — number
 * and fingerprint only, NEVER the canonical graph document. `blockedReason`
 * and a planner's `reason` are diagnostic prose that may embed a path or a
 * repository name, so both pass through the same `safe()` sanitize pipeline
 * every other free-text field in this module uses, not a hand-rolled filter.
 */
function collectGraph(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  try {
    const cap = DIAGNOSTIC_LIMITS.maxRowsPerSection
    const runs = readGraphRuns(input.store, input.ticketId, cap)
    const plannerRuns = readPlannerRuns(input.store, input.ticketId, cap)
    const nodeRuns = readNodeRuns(input.store, input.ticketId, cap)
    const omitted = runs.omitted + plannerRuns.omitted + nodeRuns.omitted
    const data = {
      runs: runs.rows.map((row) => ({
        id: row.id,
        approachId: safe(row.approachId),
        status: row.status,
        blockedReason: safe(row.blockedReason),
        plannerRunCount: row.plannerRunCount,
        expertRunCount: row.expertRunCount,
        nodeRunCount: row.nodeRunCount,
        replanCount: row.replanCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
        workspaceBytes: row.workspaceBytes,
        activeProcesses: row.activeProcesses,
        activeRevision: row.activeRevision
          ? { number: row.activeRevision.number, fingerprint: safe(row.activeRevision.fingerprint) }
          : null,
      })),
      plannerRuns: plannerRuns.rows.map((row) => ({
        id: row.id,
        graphRunId: row.graphRunId,
        kind: row.kind,
        status: row.status,
        profile: safe(row.profile),
        compileAttempt: row.compileAttempt,
        launchAttempt: row.launchAttempt,
        reason: safe(row.reason),
        startedAt: row.startedAt,
        submittedAt: row.submittedAt,
        endedAt: row.endedAt,
      })),
      nodeRuns: nodeRuns.rows.map((row) => ({
        id: row.id,
        graphRunId: row.graphRunId,
        nodeId: safe(row.nodeId),
        status: row.status,
        outcome: safe(row.outcome),
        reason: safe(row.reason),
      })),
    }
    return omitted > 0
      ? { status: 'truncated', data: json(data), omitted, reason: 'rows' }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}

function collectTopology(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
  repositories: RepositoryAliases,
): DiagnosticSection {
  try {
    const cap = DIAGNOSTIC_LIMITS.maxRowsPerSection
    const worktrees = readWorktrees(input.store, input.ticketId, cap)
    const servers = readServers(input.store, input.ticketId, cap)
    const omitted = worktrees.omitted + servers.omitted
    const data = {
      // A worktree row is keyed by repoPath, so it names as many manifest
      // entries as share that path — `repositories`, plural, rather than a
      // single alias that would have to pick one of them. `repoPathRef` joins
      // the row to the PR and merge-check rows for the same path even when the
      // manifest no longer lists any entry for it.
      worktrees: worktrees.rows.map((row) => ({
        repositories: repositories.byPath(row.repo),
        repoPathRef: input.aliases.path(row.repo),
        pathRef: input.aliases.path(row.path),
        branchRef: row.branch ? input.aliases.branch(row.branch) : null,
        baseRef: row.baseRef ? input.aliases.baseRef(row.baseRef) : null,
        depsMode: safe(row.depsMode),
      })),
      servers: servers.rows.map((row) => ({
        repository: repositories.byName(row.repo),
        status: safe(row.status),
        startedAt: row.startedAt,
        hasAddress: row.hasAddress,
      })),
      repositoryOrder: dedup(
        worktrees.rows.flatMap((row) => repositories.byPath(row.repo)),
      ),
    }
    return omitted > 0
      ? { status: 'truncated', data: json(data), omitted, reason: 'rows' }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}

function collectPullRequests(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
  repositories: RepositoryAliases,
): DiagnosticSection {
  try {
    const cap = DIAGNOSTIC_LIMITS.maxRowsPerSection
    const prs = readPullRequests(input.store, input.ticketId, cap)
    const merges = readMergeChecks(input.store, input.ticketId, cap)
    const omitted = prs.omitted + merges.omitted
    // Both tables key by repoPath, exactly as `worktrees` does — same pair of
    // fields, same reason.
    const data = {
      pullRequests: prs.rows.map((row) => ({
        repositories: repositories.byPath(row.repo),
        repoPathRef: input.aliases.path(row.repo),
        number: row.number,
        status: safe(row.status),
        hasUrl: row.hasUrl,
      })),
      mergeChecks: merges.rows.map((row) => ({
        repositories: repositories.byPath(row.repo),
        repoPathRef: input.aliases.path(row.repo),
        state: safe(row.state),
        conflictFileCount: row.conflictFileCount,
        hasHeadSha: row.hasHeadSha,
        hasBaseSha: row.hasBaseSha,
        checkedAt: row.checkedAt,
      })),
    }
    return omitted > 0
      ? { status: 'truncated', data: json(data), omitted, reason: 'rows' }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}

function collectLogs(
  snapshot: readonly LogEntry[],
  generatedAt: string,
  safe: (value: string | null) => string | null,
  ticketId: number | null,
): DiagnosticSection {
  const cutoff = new Date(generatedAt).valueOf() - DIAGNOSTIC_LIMITS.maxAgeMs
  const recent: LogEntry[] = []
  let agedOut = 0
  for (const entry of snapshot) {
    if (new Date(entry.timestamp).valueOf() >= cutoff) recent.push(entry)
    else agedOut += 1
  }
  const collapsed = collapseRepeats(recent, ticketPatternFor(ticketId))
  // Selection priority within the row/byte caps, newest first inside a class:
  // (a) every warn/error in the window, (b) ticket-scoped debug/info, (c) the
  // rest. The caps then spend on the ticketed evidence before the noise.
  const priority: Readonly<Record<LogClass, number>> = { warnError: 0, ticket: 1, other: 2 }
  const ordered = [...collapsed].sort(
    (a, b) => priority[a.class] - priority[b.class] || b.index - a.index,
  )
  const kept: CollapsedLog[] = []
  let bytes = 0
  let limitedBy: 'rows' | 'bytes' = 'rows'
  for (const entry of ordered) {
    if (kept.length >= DIAGNOSTIC_LIMITS.maxReportLogEntries) {
      limitedBy = 'rows'
      break
    }
    const size = Buffer.byteLength(entry.firstTimestamp)
      + Buffer.byteLength(entry.level)
      + Buffer.byteLength(collapsedMessage(entry))
    if (bytes + size > DIAGNOSTIC_LIMITS.maxReportLogBytes) {
      limitedBy = 'bytes'
      break
    }
    kept.push(entry)
    bytes += size
  }
  kept.sort((a, b) => a.index - b.index)
  const omittedByClass = { warnError: 0, ticket: 0, other: 0, age: agedOut }
  const keptSet = new Set(kept)
  for (const entry of collapsed) {
    if (!keptSet.has(entry)) omittedByClass[entry.class] += entry.repeats
  }
  const omitted = omittedByClass.warnError
    + omittedByClass.ticket
    + omittedByClass.other
    + omittedByClass.age
  const data = kept.map((entry) => ({
    timestamp: entry.firstTimestamp,
    level: entry.level,
    message: safe(collapsedMessage(entry)),
  }))
  return omitted > 0
    ? {
      status: 'truncated',
      data: json(data),
      omitted,
      reason: agedOut > 0 ? 'age' : limitedBy,
      omittedByClass,
    }
    : available(data)
}

/**
 * Debug/info prefixes that mark a line as ticket evidence live in
 * `logEvidence.ts` (shared with the buffer's retention). `[driver]` is
 * deliberately absent: the driver is chatty and its lines qualify only when
 * they name the report's ticket.
 */

type LogClass = 'warnError' | 'ticket' | 'other'

interface CollapsedLog {
  readonly baseMessage: string
  /** Normalized text the consecutive group was matched on. */
  readonly key: string
  readonly level: LogLevel
  readonly firstTimestamp: string
  readonly lastTimestamp: string
  /** Original position of the group's first entry, for chronological output. */
  readonly index: number
  readonly class: LogClass
  readonly repeats: number
}

const REPEAT_TICKET = /\bT\d+\b/g
const REPEAT_COUNT = /\(\s*\d+\s*\)/g

/** Consecutive-line equivalence: ticket numbers and counts are incidental. */
function repeatKey(message: string): string {
  return message.replace(REPEAT_TICKET, 'T<n>').replace(REPEAT_COUNT, '(n)')
}

function classifyLog(entry: LogEntry, ticketPattern: RegExp | null): LogClass {
  if (entry.level === 'warn' || entry.level === 'error') return 'warnError'
  if (isEvidenceMessage(entry.message)) return 'ticket'
  if (ticketPattern?.test(entry.message)) return 'ticket'
  return 'other'
}

function collapsedMessage(entry: CollapsedLog): string {
  return entry.repeats > 1
    ? `${entry.baseMessage} (repeated ${entry.repeats}× from ${entry.firstTimestamp} to ${entry.lastTimestamp})`
    : entry.baseMessage
}

function collapseRepeats(
  recent: readonly LogEntry[],
  ticketPattern: RegExp | null,
): CollapsedLog[] {
  const collapsed: CollapsedLog[] = []
  recent.forEach((entry, index) => {
    const key = repeatKey(entry.message)
    const entryClass = classifyLog(entry, ticketPattern)
    const previous = collapsed[collapsed.length - 1]
    // Never fold across a classification boundary: a ticket-named line whose
    // ticket number is normalized away (e.g. `[driver] delivery T<id>` after
    // `[driver] delivery T9000`) must not inherit the other line's class, or
    // the evidence it carries would be classified as noise and capped away.
    if (
      previous
      && previous.level === entry.level
      && previous.key === key
      && previous.class === entryClass
    ) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        repeats: previous.repeats + 1,
        lastTimestamp: entry.timestamp,
      }
      return
    }
    collapsed.push({
      baseMessage: entry.message,
      key,
      level: entry.level,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      index,
      class: entryClass,
      repeats: 1,
    })
  })
  return collapsed
}

interface CoreEvidenceSource {
  readonly store: Store
  readonly scope: { ticketId: number } | { projectId: number }
}

/**
 * Per-core usage evidence for the report's `cores` section — which agent cores
 * the ticket actually used, with headless and interactive spend, confirmed
 * sessions and models. Read from append-only sources (`token_usage`,
 * `interactive_usage_samples`, `session_launch_intents`), so a mid-session core
 * switch leaves every earlier core's rows in place: the section names ALL used
 * cores, never just the latest `tickets.session_provider` or the codex bridge.
 */
function renderCoresEvidence(
  source: CoreEvidenceSource,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  try {
    const result = readCoreUsage(
      source.store,
      source.scope,
      DIAGNOSTIC_LIMITS.maxRowsPerSection,
    )
    const data = result.rows.map((row) => ({
      core: row.core,
      headlessCalls: row.headlessCalls,
      headlessTokens: row.headlessTokens,
      interactiveCalls: row.interactiveCalls,
      interactiveTokens: row.interactiveTokens,
      sessions: row.sessions,
      models: row.models
        .map((model) => safe(model))
        .filter((model): model is string => model !== null),
      firstSeenAt: safe(row.firstSeenAt),
      lastSeenAt: safe(row.lastSeenAt),
    }))
    return result.omitted > 0
      ? {
        status: 'truncated',
        data: json(data),
        omitted: result.omitted,
        reason: 'rows',
      }
      : available(data)
  } catch {
    return { status: 'unavailable', reason: 'reader_failed' }
  }
}

function collectCores(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  return renderCoresEvidence({ store: input.store, scope: { ticketId: input.ticketId } }, safe)
}

function collectProjectCores(
  input: Omit<MetadataSources, 'ticketId'>,
  safe: (value: string | null) => string | null,
): DiagnosticSection {
  return renderCoresEvidence({ store: input.store, scope: { projectId: input.project.id } }, safe)
}
