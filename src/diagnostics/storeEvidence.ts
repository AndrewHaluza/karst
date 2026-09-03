import type { Store } from '../store/db.js'

export interface BoundedRows<T> {
  readonly rows: readonly T[]
  readonly omitted: number
}

export interface GateEvidence {
  readonly stageKey: string
  readonly attempt: number
  readonly runAt: string
  readonly gateName: string
  readonly exitCode: number | null
  readonly startedAt: string | null
  readonly endedAt: string | null
}

export interface PhaseEvidence {
  readonly stageKey: string
  readonly attempt: number
  readonly phaseName: string
  readonly markedAt: string
}

export interface StageEvidence {
  readonly stageKey: string
  readonly status: string
  readonly attempt: number
  readonly verdict: string | null
  readonly hasArtifact: boolean
  readonly startedAt: string | null
  readonly endedAt: string | null
}

export interface WorktreeEvidence {
  readonly repo: string
  readonly path: string
  readonly branch: string | null
  readonly baseRef: string | null
  readonly depsMode: string
}

export interface ServerEvidence {
  readonly repo: string
  readonly status: string
  readonly hasAddress: boolean
}

export interface PullRequestEvidence {
  readonly repo: string
  readonly number: number | null
  readonly status: string | null
  readonly hasUrl: boolean
}

export interface MergeCheckEvidence {
  readonly repo: string
  readonly state: string
  readonly conflictFileCount: number
  readonly hasHeadSha: boolean
  readonly hasBaseSha: boolean
  readonly checkedAt: string
}

function checkedCap(cap: number): number {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('Diagnostic row cap is invalid')
  return cap
}

function bounded<T>(newestFirst: readonly T[], cap: number, total = newestFirst.length): BoundedRows<T> {
  const limit = checkedCap(cap)
  const hasExtra = newestFirst.length > limit
  const kept = newestFirst.slice(0, limit).reverse()
  return {
    rows: kept,
    omitted: hasExtra ? Math.max(1, total - limit) : 0,
  }
}

/**
 * These readers deliberately select only the columns needed by diagnostics.
 * Every query is ticket-scoped and read-only; raw sensitive topology is exposed
 * only where the collector must pseudonymize it.
 */
export function readGateRuns(store: Store, ticketId: number, cap: number): BoundedRows<GateEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at,
            COUNT(*) OVER() AS total_count
       FROM gate_runs
      WHERE ticket_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    stage_key: string
    attempt: number
    run_at: string
    gate_name: string
    exit_code: number | null
    started_at: string | null
    ended_at: string | null
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      stageKey: row.stage_key,
      attempt: row.attempt,
      runAt: row.run_at,
      gateName: row.gate_name,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })),
  }
}

export function readPhaseMarks(store: Store, ticketId: number, cap: number): BoundedRows<PhaseEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT stage_key, attempt, phase_name, marked_at, COUNT(*) OVER() AS total_count
       FROM phase_marks
      WHERE ticket_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    stage_key: string
    attempt: number
    phase_name: string
    marked_at: string
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      stageKey: row.stage_key,
      attempt: row.attempt,
      phaseName: row.phase_name,
      markedAt: row.marked_at,
    })),
  }
}

export function readStages(store: Store, ticketId: number, cap: number): BoundedRows<StageEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT stage_key, status, attempt, verdict,
            (artifact_path IS NOT NULL) AS has_artifact, started_at, ended_at,
            COUNT(*) OVER() AS total_count
       FROM stages
      WHERE ticket_id = ?
      ORDER BY rowid DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    stage_key: string
    status: string
    attempt: number
    verdict: string | null
    has_artifact: number
    started_at: string | null
    ended_at: string | null
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      stageKey: row.stage_key,
      status: row.status,
      attempt: row.attempt,
      verdict: row.verdict,
      hasArtifact: row.has_artifact === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })),
  }
}

export function readWorktrees(store: Store, ticketId: number, cap: number): BoundedRows<WorktreeEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT repo, path, branch, base_ref, deps_mode, COUNT(*) OVER() AS total_count
       FROM worktrees
      WHERE ticket_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    repo: string
    path: string
    branch: string | null
    base_ref: string | null
    deps_mode: string
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      repo: row.repo,
      path: row.path,
      branch: row.branch,
      baseRef: row.base_ref,
      depsMode: row.deps_mode,
    })),
  }
}

export function readServers(store: Store, ticketId: number, cap: number): BoundedRows<ServerEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT repo, status, (host IS NOT NULL AND port IS NOT NULL) AS has_address,
            COUNT(*) OVER() AS total_count
       FROM servers
      WHERE ticket_id = ? AND kind = 'service'
      ORDER BY id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    repo: string
    status: string
    has_address: number
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      repo: row.repo,
      status: row.status,
      hasAddress: row.has_address === 1,
    })),
  }
}

export function readPullRequests(
  store: Store,
  ticketId: number,
  cap: number,
): BoundedRows<PullRequestEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT repo, number, status, (url IS NOT NULL) AS has_url,
            COUNT(*) OVER() AS total_count
       FROM prs
      WHERE ticket_id = ?
      ORDER BY rowid DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    repo: string
    number: number | null
    status: string | null
    has_url: number
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      repo: row.repo,
      number: row.number,
      status: row.status,
      hasUrl: row.has_url === 1,
    })),
  }
}

export function readMergeChecks(
  store: Store,
  ticketId: number,
  cap: number,
): BoundedRows<MergeCheckEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT repo, state,
            CASE WHEN json_valid(files) AND json_type(files) = 'array'
              THEN json_array_length(files) ELSE 0 END AS conflict_file_count,
            (head_sha IS NOT NULL) AS has_head_sha,
            (base_sha IS NOT NULL) AS has_base_sha, checked_at,
            COUNT(*) OVER() AS total_count
       FROM merge_checks
      WHERE ticket_id = ?
      ORDER BY checked_at DESC, repo DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    repo: string
    state: string
    conflict_file_count: number
    has_head_sha: number
    has_base_sha: number
    checked_at: string
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      repo: row.repo,
      state: row.state,
      conflictFileCount: row.conflict_file_count,
      hasHeadSha: row.has_head_sha === 1,
      hasBaseSha: row.has_base_sha === 1,
      checkedAt: row.checked_at,
    })),
  }
}

export interface GraphRunRevisionEvidence {
  readonly number: number
  readonly fingerprint: string
}

export interface GraphRunEvidence {
  readonly id: number
  readonly approachId: string
  readonly status: string
  readonly blockedReason: string | null
  readonly plannerRunCount: number
  readonly expertRunCount: number
  readonly nodeRunCount: number
  readonly replanCount: number
  readonly createdAt: string
  readonly updatedAt: string | null
  readonly completedAt: string | null
  readonly workspaceBytes: number
  readonly activeProcesses: number
  readonly activeRevision: GraphRunRevisionEvidence | null
}

export interface PlannerRunEvidence {
  readonly id: number
  readonly graphRunId: number
  readonly kind: string
  readonly status: string
  readonly profile: string | null
  readonly compileAttempt: number
  readonly launchAttempt: number
  readonly reason: string | null
  readonly startedAt: string | null
  readonly submittedAt: string | null
  readonly endedAt: string | null
}

export interface NodeRunEvidence {
  readonly id: number
  readonly graphRunId: number
  readonly nodeId: string
  readonly status: string
  readonly outcome: string | null
  readonly reason: string | null
}

/**
 * Graph runs owned by a ticket's `impl` stage, with the active revision's
 * number and fingerprint attached — never the canonical graph document itself
 * (G6, `docs/arch/graph-run-reliability.md`). Read-only, ticket-scoped, same
 * bounded-row shape as every other evidence reader in this module.
 */
export function readGraphRuns(store: Store, ticketId: number, cap: number): BoundedRows<GraphRunEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT r.id, r.approach_id, r.status, r.blocked_reason,
            r.planner_run_count, r.expert_run_count, r.node_run_count, r.replan_count,
            r.created_at, r.updated_at, r.completed_at, r.workspace_bytes, r.active_processes,
            rev.revision_number AS active_revision_number, rev.fingerprint AS active_revision_fingerprint,
            COUNT(*) OVER() AS total_count
       FROM approach_graph_runs r
       LEFT JOIN approach_graph_revisions rev
         ON rev.graph_run_id = r.id AND rev.status = 'active'
      WHERE r.ticket_id = ?
      ORDER BY r.id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    id: number
    approach_id: string
    status: string
    blocked_reason: string | null
    planner_run_count: number
    expert_run_count: number
    node_run_count: number
    replan_count: number
    created_at: string
    updated_at: string | null
    completed_at: string | null
    workspace_bytes: number
    active_processes: number
    active_revision_number: number | null
    active_revision_fingerprint: string | null
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      id: row.id,
      approachId: row.approach_id,
      status: row.status,
      blockedReason: row.blocked_reason,
      plannerRunCount: row.planner_run_count,
      expertRunCount: row.expert_run_count,
      nodeRunCount: row.node_run_count,
      replanCount: row.replan_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      workspaceBytes: row.workspace_bytes,
      activeProcesses: row.active_processes,
      activeRevision: row.active_revision_number !== null && row.active_revision_fingerprint !== null
        ? { number: row.active_revision_number, fingerprint: row.active_revision_fingerprint }
        : null,
    })),
  }
}

export function readPlannerRuns(store: Store, ticketId: number, cap: number): BoundedRows<PlannerRunEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT p.id, p.graph_run_id, p.kind, p.status, p.profile,
            p.compile_attempt, p.launch_attempt, p.reason,
            p.started_at, p.submitted_at, p.ended_at,
            COUNT(*) OVER() AS total_count
       FROM approach_planner_runs p
       JOIN approach_graph_runs r ON r.id = p.graph_run_id
      WHERE r.ticket_id = ?
      ORDER BY p.id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    id: number
    graph_run_id: number
    kind: string
    status: string
    profile: string | null
    compile_attempt: number
    launch_attempt: number
    reason: string | null
    started_at: string | null
    submitted_at: string | null
    ended_at: string | null
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      id: row.id,
      graphRunId: row.graph_run_id,
      kind: row.kind,
      status: row.status,
      profile: row.profile,
      compileAttempt: row.compile_attempt,
      launchAttempt: row.launch_attempt,
      reason: row.reason,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
      endedAt: row.ended_at,
    })),
  }
}

export function readNodeRuns(store: Store, ticketId: number, cap: number): BoundedRows<NodeRunEvidence> {
  const limit = checkedCap(cap)
  const rows = store.db.prepare(
    `SELECT n.id, n.graph_run_id, n.node_id, n.status, n.outcome, n.reason,
            COUNT(*) OVER() AS total_count
       FROM approach_node_runs n
       JOIN approach_graph_runs r ON r.id = n.graph_run_id
      WHERE r.ticket_id = ?
      ORDER BY n.id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
    id: number
    graph_run_id: number
    node_id: string
    status: string
    outcome: string | null
    reason: string | null
    total_count: number
  }>
  const result = bounded(rows, limit, rows[0]?.total_count ?? 0)
  return {
    ...result,
    rows: result.rows.map((row) => ({
      id: row.id,
      graphRunId: row.graph_run_id,
      nodeId: row.node_id,
      status: row.status,
      outcome: row.outcome,
      reason: row.reason,
    })),
  }
}

export interface CoreUsageTokens {
  input: number
  output: number
  /** The provider-faithful raw tally, cache reads included. */
  total: number
  /**
   * Cache READS inside that total. Carried so the report can headline FRESH
   * spend like every other surface — a cached session's re-reads dominate the
   * raw tally, and an issue whose headline says 3.9M for a 218k conversation
   * sends the reader after the wrong problem.
   */
  cacheRead: number
}

export interface CoreUsageEvidence {
  readonly core: string
  readonly headlessCalls: number
  readonly headlessTokens: CoreUsageTokens
  readonly interactiveCalls: number
  readonly interactiveTokens: CoreUsageTokens
  readonly sessions: number
  readonly models: readonly string[]
  readonly firstSeenAt: string | null
  readonly lastSeenAt: string | null
}

export type CoreUsageScope = { readonly ticketId: number } | { readonly projectId: number }

/** Mutable accumulation shape; frozen into `CoreUsageEvidence` at the end. */
interface HeldCoreUsage {
  core: string
  headlessCalls: number
  headlessTokens: CoreUsageTokens
  interactiveCalls: number
  interactiveTokens: CoreUsageTokens
  sessions: number
  models: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
}

interface CoreTotalsRow {
  core: string
  calls: number
  input: number
  output: number
  total: number
  cache_read: number
  first_at: string | null
  last_at: string | null
}

function zeroTokens(): CoreUsageTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0 }
}

function earliest(values: readonly (string | null)[]): string | null {
  const kept = values.filter((value): value is string => value !== null)
  return kept.length > 0 ? kept.reduce((a, b) => (a < b ? a : b)) : null
}

function latest(values: readonly (string | null)[]): string | null {
  const kept = values.filter((value): value is string => value !== null)
  return kept.length > 0 ? kept.reduce((a, b) => (a > b ? a : b)) : null
}

/**
 * Per-core usage evidence for the report's `cores` section. Three append-only
 * sources, merged by provider:
 *
 *  - `token_usage` — every headless AI call (provider, model, tokens);
 *  - `interactive_usage_samples` — every interactive usage observation, joined
 *    through `process_runs` for the ticket scope;
 *  - `session_launch_intents` — every prepared launch; only `confirmed` rows
 *    count as sessions.
 *
 * All three are written at the moment the event happens, so a mid-session core
 * switch leaves every earlier core's rows in place — the report describes all
 * used cores, never just the latest `tickets.session_provider`.
 */
export function readCoreUsage(
  store: Store,
  scope: CoreUsageScope,
  cap: number,
): BoundedRows<CoreUsageEvidence> {
  const limit = checkedCap(cap)
  const ticket = 'ticketId' in scope
  const params: number[] = ticket ? [scope.ticketId] : [scope.projectId]
  const scopeWhere = ticket ? 'ticket_id = ?' : 'project_id = ?'

  const headlessRows = store.db.prepare(
    `SELECT COALESCE(provider, 'unknown') AS core,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(total_tokens), 0) AS total,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
            MIN(recorded_at) AS first_at,
            MAX(recorded_at) AS last_at
       FROM token_usage
      WHERE ${scopeWhere}
      GROUP BY COALESCE(provider, 'unknown')`,
  ).all(...params) as CoreTotalsRow[]

  const interactiveRows = store.db.prepare(
    `SELECT s.provider AS core,
            COUNT(*) AS calls,
            COALESCE(SUM(s.input_tokens), 0) AS input,
            COALESCE(SUM(s.output_tokens), 0) AS output,
            COALESCE(SUM(s.total_tokens),
                     COALESCE(SUM(s.input_tokens), 0) + COALESCE(SUM(s.output_tokens), 0)
                       + COALESCE(SUM(s.cache_read_tokens), 0)) AS total,
            COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read,
            MIN(s.observed_at) AS first_at,
            MAX(s.observed_at) AS last_at
       FROM interactive_usage_samples s
       JOIN process_runs p ON p.id = s.process_run_id
       ${ticket
         ? 'WHERE p.ticket_id = ?'
         : 'JOIN tickets t ON t.id = p.ticket_id WHERE t.project_id = ?'}
      GROUP BY s.provider`,
  ).all(...params) as CoreTotalsRow[]

  const sessionRows = store.db.prepare(
    `SELECT i.provider AS core,
            COUNT(*) AS calls,
            0 AS cache_read,
            MIN(i.created_at) AS first_at,
            MAX(i.created_at) AS last_at
       FROM session_launch_intents i
       ${ticket
         ? 'WHERE i.ticket_id = ? AND i.status = ?'
         : 'JOIN tickets t ON t.id = i.ticket_id WHERE t.project_id = ? AND i.status = ?'}
      GROUP BY i.provider`,
  ).all(...params, 'confirmed') as CoreTotalsRow[]

  const modelRows = store.db.prepare(
    `SELECT provider AS core, model
       FROM token_usage
      WHERE ${scopeWhere}
        AND provider IS NOT NULL AND model IS NOT NULL AND model <> ''
      GROUP BY provider, model
      ORDER BY provider ASC, model ASC`,
  ).all(...params) as Array<{ core: string; model: string }>

  const byCore = new Map<string, HeldCoreUsage>()
  const hold = (core: string): HeldCoreUsage => {
    const existing = byCore.get(core)
    if (existing) return existing
    const held: HeldCoreUsage = {
      core,
      headlessCalls: 0,
      headlessTokens: zeroTokens(),
      interactiveCalls: 0,
      interactiveTokens: zeroTokens(),
      sessions: 0,
      models: [],
      firstSeenAt: null,
      lastSeenAt: null,
    }
    byCore.set(core, held)
    return held
  }
  const absorb = (
    held: HeldCoreUsage,
    row: CoreTotalsRow,
    field: 'headless' | 'interactive',
  ): void => {
    const tokens = field === 'headless' ? held.headlessTokens : held.interactiveTokens
    tokens.input += row.input
    tokens.output += row.output
    tokens.total += row.total
    tokens.cacheRead += row.cache_read
    held.firstSeenAt = earliest([held.firstSeenAt, row.first_at])
    held.lastSeenAt = latest([held.lastSeenAt, row.last_at])
    if (field === 'headless') held.headlessCalls += row.calls
    else held.interactiveCalls += row.calls
  }
  for (const row of headlessRows) absorb(hold(row.core), row, 'headless')
  for (const row of interactiveRows) absorb(hold(row.core), row, 'interactive')
  for (const row of sessionRows) {
    const held = hold(row.core)
    held.sessions += row.calls
    held.firstSeenAt = earliest([held.firstSeenAt, row.first_at])
    held.lastSeenAt = latest([held.lastSeenAt, row.last_at])
  }
  const modelSets = new Map<string, Set<string>>()
  for (const row of modelRows) {
    const set = modelSets.get(row.core) ?? new Set<string>()
    set.add(row.model)
    modelSets.set(row.core, set)
  }
  for (const [core, models] of modelSets) hold(core).models = [...models]

  const rows = [...byCore.values()].sort((a, b) =>
    b.headlessTokens.total + b.interactiveTokens.total - a.headlessTokens.total - a.interactiveTokens.total
    || (a.core < b.core ? -1 : a.core > b.core ? 1 : 0))
  return {
    rows: rows.slice(0, limit),
    omitted: rows.length > limit ? rows.length - limit : 0,
  }
}
