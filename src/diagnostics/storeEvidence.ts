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
      WHERE ticket_id = ?
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
