import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serverLogPath } from '../runtime/serverLog.js';
import { recordPlacement } from '../store/placement.js';
import type { Store } from '../store/db.js';
import { recordGateRun } from '../store/gateRuns.js';
import { finishProcessRun, openProcessRun } from '../store/processRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { recordShippedPr, updatePrDetail } from '../store/prs.js';
import { openRecoveryRound } from '../store/recoveryRoundsWrite.js';
import { setStage } from '../store/stages.js';
import { closeStageRun, openStageRun } from '../store/stageRuns.js';
import { archiveTicket, createTicket, setStageCurrent, updateTicketFields } from '../store/tickets.js';
import { UNKNOWN_PR_DETAIL } from '../integrations/github.js';
import type { FixtureSpec, RepoBinding, RowSeeds, ServerSeed } from './fixtures.js';

const AT = '2026-01-01T00:00:00.000Z';
const DEFAULT_BINDING: RepoBinding = { repoPath: '/fixture/repo', baseRef: 'main', worktreePath: '' };

/**
 * Starts a process that holds `port`, so a `running` fixture row answers a port
 * probe: detached and unref'd, so it outlives this prepare process and the host
 * can stop it like any other server.
 */
export type SpawnServer = (port: number) => number | null;

export function spawnHoldingServer(port: number): number | null {
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('ok')).listen(${port})`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
}

/** A log of `bytes` bytes: fixed lines, so two runs of a fixture are identical. */
export function writeFixtureLog(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.UTC(2026, 0, 1);
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i += 1) {
    const at = new Date(start + i * 1000).toISOString();
    const line = `${at} INFO req=${String(i).padStart(6, '0')} GET /api/items?page=${i % 20} 200 3ms ${'x'.repeat(40)}\n`;
    lines.push(line);
    size += Buffer.byteLength(line);
  }
  writeFileSync(path, lines.join(''));
}

/** The directory a ticket's servers run in: its worktree, or the workspace repo. */
function serverCwd(seed: FixtureSpec['tickets'][number], fallback: RepoBinding): string {
  const binding = seed.repo ?? fallback;
  return seed.worktree ? binding.worktreePath || join(binding.repoPath, '.karst', 'worktrees', seed.key) : binding.repoPath;
}

function seedServers(
  store: Store,
  spec: FixtureSpec,
  ticketIds: ReadonlyMap<string, number>,
  fallback: RepoBinding,
  spawnServer: SpawnServer,
): void {
  for (const s of spec.servers ?? []) {
    const seed = spec.tickets.find((t) => t.key === s.ticket);
    if (!seed) throw new Error(`seedStore: server "${s.service}" names unknown ticket "${s.ticket}"`);
    const cwd = serverCwd(seed, fallback);
    const logPath = serverLogPath(cwd, s.service);
    if (s.logBytes) writeFixtureLog(logPath, s.logBytes);
    const pid = s.status === 'running' ? spawnServer(s.port) : null;
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticketIds.get(s.ticket)!, s.service, 'localhost', s.port, pid, s.status, logPath, cwd, AT, s.status === 'failed' ? (s.lastError ?? null) : null);
  }
}

/** What a seed needs beyond the file: the repo the worktree rows point at, and how to start a server. */
export interface SeedDefaults {
  repoPath?: string;
  /** How a `running` server row gets its process. Injected so a unit test spawns nothing. */
  spawnServer?: SpawnServer;
}

function seedRows(store: Store, ticketId: number, rows: Partial<RowSeeds>): void {
  const stageRunIds = (rows.stageRuns ?? []).map((r, i) => {
    const id = openStageRun(store, { ticketId, stageKey: r.stageKey, attempt: r.attempt, runAt: `${AT}#${i}`, startedAt: AT });
    if (r.status === 'finished') closeStageRun(store, id, r.outcome ?? 'stopped', AT);
    return id;
  });
  for (const r of rows.processRuns ?? []) {
    const run = openProcessRun(store, {
      ticketId, stageKey: r.stageKey, processId: r.processId, attempt: r.attempt, startedAt: AT,
      ...(r.stageRun === undefined ? {} : { stageRunId: stageRunIds[r.stageRun]! }),
    });
    if (r.status !== 'running') finishProcessRun(store, run.id, r.status, AT);
  }
  for (const r of rows.gateRuns ?? []) {
    recordGateRun(store, {
      ticketId, stageKey: r.stageKey, attempt: r.attempt, runAt: AT,
      gates: [{ gateName: r.gateName, exitCode: r.exitCode }],
      ...(r.stageRun === undefined ? {} : { stageRunId: stageRunIds[r.stageRun]! }),
    });
  }
  for (const r of rows.recoveryRounds ?? []) {
    openRecoveryRound(store, {
      ticketId, ...r, sourceStageRunId: null, sourceProcessRunId: null, startedAt: AT,
    });
  }
  for (const r of rows.prs ?? []) {
    recordShippedPr(store, { ticketId, repo: r.repo, number: r.number, url: r.url });
    updatePrDetail(store, {
      ticketId, repo: r.repo, url: r.url,
      detail: {
        ...UNKNOWN_PR_DETAIL, status: r.status, headRef: r.headRef ?? null, baseRef: r.baseRef ?? null,
        mergeBlock: r.mergeBlock ?? 'unknown',
      },
    });
  }
  for (const r of rows.mergeChecks ?? []) setMergeCheck(store, { ticketId, ...r, checkedAt: AT });
  for (const r of rows.reviewFindings ?? []) {
    recordFindings(store, {
      ticketId, attempt: r.attempt, runAt: `${AT}#a${r.attempt}`,
      findings: [{ severity: r.severity, repo: r.repo, file: r.file, line: r.line, title: r.title, detail: r.detail, source: r.source }],
    });
  }
}

/** Seeds through the store APIs (never raw SQL) so the schema's own rules hold. */
export function seedStore(store: Store, spec: FixtureSpec, defaults?: SeedDefaults): number[] {
  const fallback: RepoBinding = { ...DEFAULT_BINDING, ...(defaults ?? {}) };
  const ids = spec.tickets.map((seed) => {
    const ticket = createTicket(store, { key: seed.key, title: seed.title, ...(seed.description === undefined ? {} : { description: seed.description }) });
    setStageCurrent(store, ticket.id, seed.stageCurrent);
    if (seed.selectedRepos) updateTicketFields(store, ticket.id, { selectedRepos: seed.selectedRepos });
    for (const s of seed.stages) setStage(store, ticket.id, s.stageKey, s.patch);
    if (seed.placement) recordPlacement(store, ticket.id, { backend: seed.placement, core: null, sandboxName: null, reason: null }, null);
    if (seed.worktree) {
      const binding = seed.repo ?? fallback;
      store.db
        .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
        .run(ticket.id, seed.worktreeRepo ?? binding.repoPath, binding.worktreePath || `${binding.repoPath}/.karst/worktrees/${seed.key}`, `karst/${seed.key}`, binding.baseRef);
    }
    if (seed.rows) seedRows(store, ticket.id, seed.rows);
    if (seed.archived) archiveTicket(store, ticket.id);
    return ticket.id;
  });
  if (spec.servers?.length) {
    const byKey = new Map(spec.tickets.map((t, i) => [t.key, ids[i]!] as const));
    seedServers(store, spec, byKey, fallback, defaults?.spawnServer ?? spawnHoldingServer);
  }
  return ids;
}
