import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db.js'
import { upsertProject } from '../store/projects.js'
import { createTicket } from '../store/tickets.js'
import {
  readCoreUsage,
  readGateRuns,
  readMergeChecks,
  readNodeDeferrals,
  readNodeRuns,
  readPhaseMarks,
  readPullRequests,
  readResourceLeases,
  readServers,
  readStages,
  readWorktrees,
} from './storeEvidence.js'

describe('diagnostic store evidence', () => {
  let store: Store | undefined
  afterEach(() => store?.close())

  it('marks a host re-run gate row and leaves a batch row unmarked', () => {
    store = openStore(':memory:')
    const ins = store.db.prepare(
      `INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, source)
       VALUES (7, 'uat', 1, '2026-07-01T00:00:00.000Z', ?, 0, ?)`,
    )
    ins.run('batch', null)
    ins.run('rerun', 'host-rerun')
    const rows = readGateRuns(store, 7, 10).rows
    expect(rows.find((r) => r.gateName === 'batch')?.hostRerun).toBeUndefined()
    expect(rows.find((r) => r.gateName === 'rerun')?.hostRerun).toBe(true)
  })

  it('retains the newest bounded gate/phase window in chronological order', () => {
    store = openStore(':memory:')
    for (let i = 1; i <= 4; i++) {
      store.db.prepare(
        `INSERT INTO gate_runs
          (ticket_id, stage_key, attempt, run_at, gate_name, exit_code)
         VALUES (?, 'uat', ?, ?, ?, ?)`,
      ).run(7, i, `2026-07-0${i}T00:00:00.000Z`, `gate-${i}`, i)
      store.db.prepare(
        `INSERT INTO phase_marks
          (ticket_id, stage_key, attempt, phase_name, marked_at)
         VALUES (?, 'impl', ?, ?, ?)`,
      ).run(7, i, `phase-${i}`, `2026-07-0${i}T00:00:00.000Z`)
    }
    store.db.prepare(
      `INSERT INTO gate_runs
        (ticket_id, stage_key, attempt, run_at, gate_name, exit_code)
       VALUES (8, 'uat', 99, '2099-01-01T00:00:00.000Z', 'other-ticket', 99)`,
    ).run()

    expect(readGateRuns(store, 7, 2)).toEqual({
      rows: [
        expect.objectContaining({ attempt: 3, gateName: 'gate-3' }),
        expect.objectContaining({ attempt: 4, gateName: 'gate-4' }),
      ],
      omitted: 2,
    })
    expect(readPhaseMarks(store, 7, 2)).toEqual({
      rows: [
        expect.objectContaining({ attempt: 3, phaseName: 'phase-3' }),
        expect.objectContaining({ attempt: 4, phaseName: 'phase-4' }),
      ],
      omitted: 2,
    })
  })

  it('readServers excludes graph-agent rows', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    store.db.prepare(
      "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'api', 1, 'running', '/wt/api', '2026-08-12T00:00:00.000Z', 'service')",
    ).run(ticket.id)
    store.db.prepare(
      "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'api', 2, 'running', '/wt/api', '2026-08-12T00:00:00.000Z', 'agent')",
    ).run(ticket.id)
    const result = readServers(store, ticket.id, 10)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.repo).toBe('api')
  })

  it('projects topology and PR state without addresses, URLs, reasons, SHAs, or conflict paths', () => {
    store = openStore(':memory:')
    store.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (7, 'api', '/secret/worktree', 'secret-branch', 'secret-base', 'local')`,
    ).run()
    store.db.prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at)
       VALUES (7, 'api', 'private.host', 4444, 1, 'running', '/secret/log',
               '2026-07-28T09:00:00.000Z')`,
    ).run()
    store.db.prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status)
       VALUES (7, 'api', 12, 'https://token@example.test/pr/12', 'open')`,
    ).run()
    store.db.prepare(
      `INSERT INTO merge_checks
       (ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)
       VALUES (7, 'api', 'conflicted', '["/secret/file"]', 'credential=secret',
               'head-secret', 'base-secret', 'refs/secret', '2026-07-28T00:00:00.000Z')`,
    ).run()

    expect(readWorktrees(store, 7, 10).rows).toEqual([{
      repo: 'api',
      path: '/secret/worktree',
      branch: 'secret-branch',
      baseRef: 'secret-base',
      depsMode: 'local',
    }])
    expect(readServers(store, 7, 10).rows).toEqual([{
      repo: 'api',
      status: 'running',
      startedAt: '2026-07-28T09:00:00.000Z',
      hasAddress: true,
    }])
    expect(readPullRequests(store, 7, 10).rows).toEqual([{
      repo: 'api',
      number: 12,
      status: 'open',
      hasUrl: true,
    }])
    expect(readMergeChecks(store, 7, 10).rows).toEqual([{
      repo: 'api',
      state: 'conflicted',
      conflictFileCount: 1,
      hasHeadSha: true,
      hasBaseSha: true,
      checkedAt: '2026-07-28T00:00:00.000Z',
    }])
  })

  it('bounds stages deterministically and reports the true omitted count', () => {
    store = openStore(':memory:')
    for (let i = 1; i <= 4; i++) {
      store.db.prepare(
        `INSERT INTO stages
          (ticket_id, stage_key, status, attempt, artifact_path)
         VALUES (7, ?, 'failed', ?, ?)`,
      ).run(`stage-${i}`, i, `/private/artifact-${i}`)
    }
    expect(readStages(store, 7, 2)).toEqual({
      rows: [
        expect.objectContaining({ stageKey: 'stage-3', attempt: 3, hasArtifact: true }),
        expect.objectContaining({ stageKey: 'stage-4', attempt: 4, hasArtifact: true }),
      ],
      omitted: 2,
    })
  })

  it('derives merge conflict counts in SQL without selecting raw file JSON', () => {
    store = openStore(':memory:')
    store.db.prepare(
      `INSERT INTO merge_checks
       (ticket_id, repo, state, files, checked_at)
       VALUES (7, 'api', 'conflicted', '["PRIVATE_PATH_1","PRIVATE_PATH_2"]',
               '2026-07-28T00:00:00.000Z')`,
    ).run()
    const sql: string[] = []
    const original = store.db.prepare.bind(store.db)
    const wrapped = {
      ...store,
      db: new Proxy(store.db, {
        get(target, property, receiver) {
          if (property !== 'prepare') return Reflect.get(target, property, receiver)
          return (statement: string) => {
            sql.push(statement)
            return original(statement)
          }
        },
      }),
    } as Store
    expect(readMergeChecks(wrapped, 7, 10).rows[0]?.conflictFileCount).toBe(2)
    const selectList = sql[0]!.split(/\bFROM\b/i)[0]!
    expect(selectList).not.toMatch(/\bfiles\s*,/i)
    expect(selectList).toMatch(/json_array_length\(files\)/i)
  })

  it('reports true omitted counts for every bounded topology and PR reader', () => {
    store = openStore(':memory:')
    for (let i = 1; i <= 4; i++) {
      store.db.prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, deps_mode)
         VALUES (7, ?, ?, 'inherited')`,
      ).run(`repo-${i}`, `/private/${i}`)
      store.db.prepare(
        `INSERT INTO servers (ticket_id, repo, status) VALUES (7, ?, 'stopped')`,
      ).run(`repo-${i}`)
      store.db.prepare(
        `INSERT INTO prs (ticket_id, repo, number, status) VALUES (7, ?, ?, 'open')`,
      ).run(`repo-${i}`, i)
      store.db.prepare(
        `INSERT INTO merge_checks
         (ticket_id, repo, state, files, checked_at)
         VALUES (7, ?, 'clean', '[]', ?)`,
      ).run(`repo-${i}`, `2026-07-0${i}T00:00:00.000Z`)
    }
    expect(readWorktrees(store, 7, 2).omitted).toBe(2)
    expect(readServers(store, 7, 2).omitted).toBe(2)
    expect(readPullRequests(store, 7, 2).omitted).toBe(2)
    expect(readMergeChecks(store, 7, 2).omitted).toBe(2)
  })

  function seedUsageEvidence(store: Store, ticketId: number, projectId: number, tag = ''): void {
    const providerSessionId = `sess-codex${tag}`
    store.db.prepare(
      `INSERT INTO token_usage
        (project_id, ticket_id, call_site, provider, model, input_tokens, output_tokens,
         total_tokens, estimated, outcome, recorded_at)
       VALUES (?, ?, 'uat-tester', 'codex', 'gpt-5-codex', 100, 40, 140, 0, 'ok', '2026-07-28T09:00:00.000Z'),
              (?, ?, 'uat-tester', 'codex', 'gpt-5-codex', 200, 60, 260, 0, 'ok', '2026-07-28T10:00:00.000Z'),
              (?, ?, 'pr-description', 'claude', 'opus', 30, 10, 40, 0, 'ok', '2026-07-29T08:00:00.000Z'),
              (?, ?, 'ticket-analysis', NULL, NULL, 5, 1, 6, 0, 'ok', '2026-07-29T09:00:00.000Z')`,
    ).run(projectId, ticketId, projectId, ticketId, projectId, ticketId, projectId, ticketId)
    store.db.prepare(
      `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
       VALUES (?, 'impl', 'session', 1, 'passed', '2026-07-28T08:00:00.000Z')`,
    ).run(ticketId)
    const processId = (
      store.db.prepare('SELECT id FROM process_runs WHERE ticket_id = ?').get(ticketId) as { id: number }
    ).id
    store.db.prepare(
      `INSERT INTO interactive_usage_samples
        (process_run_id, source_event_id, provider, provider_session_id,
         input_tokens, output_tokens, total_tokens, baseline_only, observed_at)
       VALUES (?, 'ev-1', 'codex', ?, 500, 200, 700, 0, '2026-07-28T11:00:00.000Z'),
              (?, 'ev-2', 'codex', ?, 300, 100, 400, 0, '2026-07-28T12:00:00.000Z')`,
    ).run(processId, providerSessionId, processId, providerSessionId)
    store.db.prepare(
      `INSERT INTO session_launch_intents
        (ticket_id, launch_id, purpose, provider, model, reason, session_origin, status, created_at, resolved_at)
       VALUES (?, 'launch-a${tag}', 'implementation', 'codex', 'gpt-5-codex', 'open', 'new', 'confirmed', '2026-07-28T08:00:00.000Z', '2026-07-28T08:01:00.000Z'),
              (?, 'launch-b${tag}', 'implementation', 'claude', 'opus', 'switch', 'new', 'confirmed', '2026-07-29T08:00:00.000Z', '2026-07-29T08:01:00.000Z'),
              (?, 'launch-c${tag}', 'implementation', 'codex', 'gpt-5-codex', 'retry', 'new', 'failed', '2026-07-29T09:00:00.000Z', '2026-07-29T09:01:00.000Z')`,
    ).run(ticketId, ticketId, ticketId)
  }

  it('aggregates per-core usage from token_usage, interactive samples and confirmed launches', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    seedUsageEvidence(store, ticket.id, project.id)

    const result = readCoreUsage(store, { ticketId: ticket.id }, 10)
    const byCore = new Map(result.rows.map((row) => [row.core, row]))
    expect(byCore.get('codex')).toMatchObject({
      core: 'codex',
      headlessCalls: 2,
      headlessTokens: { input: 300, output: 100, total: 400 },
      interactiveCalls: 2,
      interactiveTokens: { input: 800, output: 300, total: 1100 },
      sessions: 1, // the 'failed' launch is not a session
      models: ['gpt-5-codex'],
      firstSeenAt: '2026-07-28T08:00:00.000Z',
      lastSeenAt: '2026-07-28T12:00:00.000Z',
    })
    expect(byCore.get('claude')).toMatchObject({
      core: 'claude',
      headlessCalls: 1,
      headlessTokens: { input: 30, output: 10, total: 40 },
      interactiveCalls: 0,
      interactiveTokens: { input: 0, output: 0, total: 0 },
      sessions: 1,
      models: ['opus'],
    })
    // NULL provider rows stay visible under 'unknown' — never dropped.
    expect(byCore.get('unknown')).toMatchObject({
      core: 'unknown',
      headlessCalls: 1,
      headlessTokens: { input: 5, output: 1, total: 6 },
    })
    expect(result.omitted).toBe(0)
  })

  it('scopes readCoreUsage to the ticket or project and caps rows', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const other = upsertProject(store, { slug: 'q' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    const otherTicket = createTicket(store, { projectId: other.id, key: 'K-2', title: 't2' })
    seedUsageEvidence(store, ticket.id, project.id)
    seedUsageEvidence(store, otherTicket.id, other.id, '-2')

    const scoped = readCoreUsage(store, { ticketId: ticket.id }, 10)
    expect(scoped.rows.length).toBe(3)
    expect(scoped.rows.map((row) => row.core).sort()).toEqual(['claude', 'codex', 'unknown'])

    const projectWide = readCoreUsage(store, { projectId: project.id }, 10)
    expect(projectWide.rows.length).toBe(3)
    expect(readCoreUsage(store, { projectId: other.id }, 10).rows.map((row) => row.core).sort()).toEqual(
      ['claude', 'codex', 'unknown'],
    )
    expect(readCoreUsage(store, { ticketId: ticket.id }, 2).omitted).toBe(1)
    expect(readCoreUsage(store, { ticketId: 99999 }, 10).rows).toEqual([])
  })

  it('reads enriched node runs, deferrals and resource leases with bounded counts', () => {
    store = openStore(':memory:')
    const project = upsertProject(store, { slug: 'p' })
    const ticket = createTicket(store, { projectId: project.id, key: 'K-1', title: 't' })
    const otherTicket = createTicket(store, { projectId: project.id, key: 'K-2', title: 't2' })

    store.db.prepare(
      `INSERT INTO approach_graph_runs
         (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (10, ?, 'impl', 1, 'karst-graph-engineering', 'running', '2026-08-16T00:00:00.000Z'),
              (20, ?, 'impl', 1, 'karst-graph-engineering', 'running', '2026-08-16T00:00:00.000Z')`,
    ).run(ticket.id, otherTicket.id)

    store.db.prepare(
      `INSERT INTO approach_graph_revisions
         (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (100, 10, 1, '{}', 'fp1', 'active', '2026-08-16T00:00:00.000Z')`,
    ).run()

    for (let i = 1; i <= 3; i++) {
      store.db.prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, launch_attempt, launch_fail_streak, outcome, reason, started_at, ended_at)
         VALUES (?, 10, 100, ?, 'agent', ?, 'completed', 1, 0, 'complete', 'ok', '2026-08-16T00:01:00.000Z', '2026-08-16T00:02:00.000Z')`,
      ).run(i, `node-${i}`, i)

      store.db.prepare(
        `INSERT INTO approach_node_deferrals
           (id, graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, 10, 100, ?, 'lease-held', '2026-08-16T00:01:00.000Z', '2026-08-16T00:02:00.000Z')`,
      ).run(i, `node-${i}`)

      store.db.prepare(
        `INSERT INTO approach_resource_leases
           (id, graph_run_id, owner_node_run_id, physical_domain, access_mode, claimed_paths, status, acquired_at, released_at)
         VALUES (?, 10, 1, ?, 'shared', '["/path"]', 'held', '2026-08-16T00:01:00.000Z', NULL)`,
      ).run(i, `domain-${i}`)
    }

    // Node runs (retained in chronological order: id 2, then id 3)
    const nodeRuns = readNodeRuns(store, ticket.id, 2)
    expect(nodeRuns.rows).toHaveLength(2)
    expect(nodeRuns.omitted).toBe(1)
    expect(nodeRuns.rows[1]).toMatchObject({
      id: 3,
      graphRunId: 10,
      nodeId: 'node-3',
      nodeKind: 'agent',
      visitNumber: 3,
      status: 'completed',
      launchAttempt: 1,
      launchFailStreak: 0,
      outcome: 'complete',
      reason: 'ok',
      startedAt: '2026-08-16T00:01:00.000Z',
      endedAt: '2026-08-16T00:02:00.000Z',
    })

    // Node deferrals (chronological order)
    const deferrals = readNodeDeferrals(store, ticket.id, 2)
    expect(deferrals.rows).toHaveLength(2)
    expect(deferrals.omitted).toBe(1)
    expect(deferrals.rows[1]).toMatchObject({
      id: 3,
      graphRunId: 10,
      revisionId: 100,
      nodeId: 'node-3',
      reason: 'lease-held',
      waitSince: '2026-08-16T00:01:00.000Z',
      updatedAt: '2026-08-16T00:02:00.000Z',
    })

    // Resource leases (chronological order)
    const leases = readResourceLeases(store, ticket.id, 2)
    expect(leases.rows).toHaveLength(2)
    expect(leases.omitted).toBe(1)
    expect(leases.rows[1]).toMatchObject({
      id: 3,
      graphRunId: 10,
      ownerNodeRunId: 1,
      physicalDomain: 'domain-3',
      accessMode: 'shared',
      claimedPaths: '["/path"]',
      status: 'held',
      acquiredAt: '2026-08-16T00:01:00.000Z',
      releasedAt: null,
    })

    // Scoped to ticket
    expect(readNodeRuns(store, otherTicket.id, 10).rows).toEqual([])
    expect(readNodeDeferrals(store, otherTicket.id, 10).rows).toEqual([])
    expect(readResourceLeases(store, otherTicket.id, 10).rows).toEqual([])
  })
})
