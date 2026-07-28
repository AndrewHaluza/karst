import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db.js'
import {
  readGateRuns,
  readMergeChecks,
  readPhaseMarks,
  readPullRequests,
  readServers,
  readStages,
  readWorktrees,
} from './storeEvidence.js'

describe('diagnostic store evidence', () => {
  let store: Store | undefined
  afterEach(() => store?.close())

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

  it('projects topology and PR state without addresses, URLs, reasons, SHAs, or conflict paths', () => {
    store = openStore(':memory:')
    store.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (7, 'api', '/secret/worktree', 'secret-branch', 'secret-base', 'local')`,
    ).run()
    store.db.prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
       VALUES (7, 'api', 'private.host', 4444, 1, 'running', '/secret/log')`,
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
})
