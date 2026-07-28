import { resolveModelForProvider } from '../agent/models.js'
import { resolveProvider } from '../agent/provider.js'
import type { LogBuffer, LogEntry } from '../logging/logger.js'
import type { Manifest } from '../manifest/types.js'
import type { Store } from '../store/db.js'
import type { Project } from '../store/projects.js'
import { DIAGNOSTIC_LIMITS } from './limits.js'
import { projectEffectiveConfig } from './projectConfig.js'
import type { Pseudonymizer } from './pseudonymize.js'
import { sanitizeText } from './redact.js'
import {
  readGateRuns,
  readMergeChecks,
  readPhaseMarks,
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

export interface RuntimeDiagnosticInput {
  readonly extensionVersion: string
  readonly editorVersion: string
  readonly platform: string
  readonly arch: string
  readonly remoteNamePresent: boolean
  readonly uiKind: string
  readonly developmentMode: boolean
}

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
  agent_provider: 'claude' | 'codex' | 'antigravity' | null
  session_provider: 'claude' | 'codex' | 'antigravity' | null
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
            selected_repos, archived_at, model, agent_provider, session_provider
       FROM tickets
      WHERE id = ? AND project_id = ?`,
  ).get(input.ticketId, input.project.id) as DiagnosticTicketRow
  const redactions: Record<string, number> = {}
  const safe = (value: string | null): string | null => {
    if (value === null) return null
    const sanitized = sanitizeText(value)
    for (const [category, count] of Object.entries(sanitized.counts)) {
      if (category !== 'total') redactions[category] = (redactions[category] ?? 0) + count
    }
    return sanitized.value
  }
  const repositoryNames = selectedRepos(ticket.selected_repos)
  const repositoryRefs = new Map<string, string>()
  const repositoryAlias = (name: string): string => {
    const existing = repositoryRefs.get(name)
    if (existing) return existing
    const alias = `repo_${repositoryRefs.size + 1}`
    repositoryRefs.set(name, alias)
    return alias
  }
  const provider = resolveProvider(ticket.agent_provider, input.manifest.agentProvider)
  const model = resolveModelForProvider(provider, ticket.model, input.manifest.defaultModel)
  const mapRepositories = (values: readonly string[]): string[] => values.map(repositoryAlias)

  const metadata: Partial<Record<DiagnosticSectionName, DiagnosticSection>> = {
    runtime: available({
      extensionVersion: safe(input.runtime.extensionVersion),
      editorVersion: safe(input.runtime.editorVersion),
      platform: safe(input.runtime.platform),
      arch: safe(input.runtime.arch),
      remoteNamePresent: input.runtime.remoteNamePresent,
      uiKind: safe(input.runtime.uiKind),
      developmentMode: input.runtime.developmentMode,
    }),
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
      repositoryAlias,
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
  metadata.topology = collectTopology(input, safe, repositoryAlias)
  await yieldToHost(input.isCancelled)
  metadata.pullRequest = collectPullRequests(input, safe, repositoryAlias)
  await yieldToHost(input.isCancelled)
  metadata.logs = collectLogs(input.logs.snapshot(), input.generatedAt, safe)

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
  const safe = (value: string | null): string | null => {
    if (value === null) return null
    const sanitized = sanitizeText(value)
    for (const [category, count] of Object.entries(sanitized.counts)) {
      if (category !== 'total') redactions[category] = (redactions[category] ?? 0) + count
    }
    return sanitized.value ?? '[OMITTED:unsafe-metadata]'
  }
  const repositoryRefs = new Map<string, string>()
  const repositoryAlias = (name: string): string => {
    const existing = repositoryRefs.get(name)
    if (existing) return existing
    const alias = `repo_${repositoryRefs.size + 1}`
    repositoryRefs.set(name, alias)
    return alias
  }
  const repositories = Object.keys(input.manifest.repositories)
  return {
    reportId: input.reportId,
    generatedAt: input.generatedAt,
    contextStatus: 'not-requested',
    metadata: {
      runtime: available({
        extensionVersion: safe(input.runtime.extensionVersion),
        editorVersion: safe(input.runtime.editorVersion),
        platform: safe(input.runtime.platform),
        arch: safe(input.runtime.arch),
        remoteNamePresent: input.runtime.remoteNamePresent,
        uiKind: safe(input.runtime.uiKind),
        developmentMode: input.runtime.developmentMode,
      }),
      effectiveConfig: available(projectEffectiveConfig(input.manifest, {
        projectIdentity: input.manifest.id ?? input.project.slug,
        selectedRepos: repositories,
        selectedApproach: null,
        resolvedModel: input.manifest.defaultModel,
        resolvedProvider: resolveProvider(undefined, input.manifest.agentProvider),
        aliases: input.aliases,
        repositoryAlias,
      })),
      logs: collectLogs(input.logs.snapshot(), input.generatedAt, safe),
    },
    exclusions: [
      'credentials, tokens, private keys, environment and SecretStorage',
      'ticket and session context, transcripts, prompts, repository files and stage artifacts',
      'raw paths, commands, URLs, host addresses and unrelated project data',
    ],
    redactions,
  }
}

function collectTopology(
  input: MetadataSources,
  safe: (value: string | null) => string | null,
  repositoryAlias: (name: string) => string,
): DiagnosticSection {
  try {
    const cap = DIAGNOSTIC_LIMITS.maxRowsPerSection
    const worktrees = readWorktrees(input.store, input.ticketId, cap)
    const servers = readServers(input.store, input.ticketId, cap)
    const omitted = worktrees.omitted + servers.omitted
    const data = {
      worktrees: worktrees.rows.map((row) => ({
        repository: repositoryAlias(row.repo),
        pathRef: input.aliases.path(row.path),
        branchRef: row.branch ? input.aliases.branch(row.branch) : null,
        baseRef: row.baseRef ? input.aliases.baseRef(row.baseRef) : null,
        depsMode: safe(row.depsMode),
      })),
      servers: servers.rows.map((row) => ({
        repository: repositoryAlias(row.repo),
        status: safe(row.status),
        hasAddress: row.hasAddress,
      })),
      repositoryOrder: worktrees.rows.map((row) => repositoryAlias(row.repo)),
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
  repositoryAlias: (name: string) => string,
): DiagnosticSection {
  try {
    const cap = DIAGNOSTIC_LIMITS.maxRowsPerSection
    const prs = readPullRequests(input.store, input.ticketId, cap)
    const merges = readMergeChecks(input.store, input.ticketId, cap)
    const omitted = prs.omitted + merges.omitted
    const data = {
      pullRequests: prs.rows.map((row) => ({
        repository: repositoryAlias(row.repo),
        number: row.number,
        status: safe(row.status),
        hasUrl: row.hasUrl,
      })),
      mergeChecks: merges.rows.map((row) => ({
        repository: repositoryAlias(row.repo),
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
): DiagnosticSection {
  const cutoff = new Date(generatedAt).valueOf() - DIAGNOSTIC_LIMITS.maxAgeMs
  const recent = snapshot.filter((entry) => new Date(entry.timestamp).valueOf() >= cutoff)
  const byRows = recent.slice(-DIAGNOSTIC_LIMITS.maxReportLogEntries)
  const kept: LogEntry[] = []
  let bytes = 0
  for (let i = byRows.length - 1; i >= 0; i--) {
    const entry = byRows[i]!
    const size = Buffer.byteLength(entry.timestamp)
      + Buffer.byteLength(entry.level)
      + Buffer.byteLength(entry.message)
    if (bytes + size > DIAGNOSTIC_LIMITS.maxReportLogBytes) break
    kept.unshift(entry)
    bytes += size
  }
  const omitted = snapshot.length - kept.length
  const data = kept.map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level,
    message: safe(entry.message),
  }))
  return omitted > 0
    ? {
      status: 'truncated',
      data: json(data),
      omitted,
      reason: recent.length < snapshot.length
        ? 'age'
        : recent.length > DIAGNOSTIC_LIMITS.maxReportLogEntries
          ? 'rows'
          : 'bytes',
    }
    : available(data)
}
