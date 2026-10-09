import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import { dependencyRegistry, binaryExists, commandSucceeds, readCommandOutput } from '../runtime/deps.js';
import { SCHEMA_VERSION } from '../store/schemaVersion.js';
import { checkTools } from '../doctor/toolsChecks.js';
import { checkManifest } from '../doctor/manifestChecks.js';
import { checkState } from '../doctor/stateChecks.js';
import { checkStuckTickets } from '../doctor/stuckCheck.js';
import { checkWiring } from '../doctor/wiringChecks.js';
import { parseDoctorArea, renderDoctorText, runDoctor } from '../doctor/run.js';
import { parseDbTimeMs, type FixEffects } from '../doctor/applyFixes.js';
import * as probes from '../doctor/probes.js';
import type { DoctorArea, DoctorCheck } from '../doctor/types.js';

/** Defaults until a manifest field exists for them. */
export const DOCTOR_STUCK_MINUTES = 120;
export const DOCTOR_WAL_LIMIT_BYTES = 64 * 1024 * 1024;

export interface ParsedDoctorArgs {
  fix: boolean;
  json: boolean;
  areas: DoctorArea[];
}

export function parseDoctorArgs(rest: readonly string[]): ParsedDoctorArgs {
  const out: ParsedDoctorArgs = { fix: false, json: false, areas: [] };
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === '--fix') out.fix = true;
    else if (t === '--json') out.json = true;
    else if (t === '--area') {
      const v = rest[++i];
      if (v === undefined) throw new Error('karst doctor: --area needs a value');
      out.areas.push(parseDoctorArea(v));
    } else throw new Error(`karst doctor: unexpected argument '${t}'`);
  }
  return out;
}

/** Thrown to carry doctor's exit code through the CLI's single catch. */
export class DoctorExit extends Error {
  constructor(
    readonly output: string,
    readonly code: 0 | 1,
  ) {
    super(output);
  }
}

interface TicketRow { id: number; key: string; stage_current: string | null; agent_state: string | null; archived_at: string | null; paused_at: string | null; updated_at: string }

function stateProbes(store: Store, dbPath: string) {
  const rows = <T>(sql: string): T[] => store.db.prepare(sql).all() as T[];
  const worktrees = rows<{ ticket_id: number; key: string; stage_current: string | null; repo: string; path: string; branch: string | null }>(
    'SELECT w.ticket_id, t.key, t.stage_current, w.repo, w.path, w.branch FROM worktrees w JOIN tickets t ON t.id = w.ticket_id',
  ).map((w) => ({ ticketId: w.ticket_id, ticketKey: w.key, ticketStage: w.stage_current, repo: w.repo, path: w.path, branch: w.branch }));
  const servers = rows<{ id: number; ticket_id: number | null; stage_current: string | null; repo: string; port: number | null; pid: number | null; status: string; started_at: string; kind: string }>(
    'SELECT s.id, s.ticket_id, t.stage_current, s.repo, s.port, s.pid, s.status, s.started_at, s.kind FROM servers s LEFT JOIN tickets t ON t.id = s.ticket_id',
  ).map((s) => ({ id: s.id, ticketId: s.ticket_id, ticketStage: s.stage_current, repo: s.repo, port: s.port, pid: s.pid, status: s.status, startedAt: s.started_at, kind: s.kind }));
  const dbVersion = (store.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0;
  return {
    worktrees, servers,
    pathExists: probes.pathExists, branchExists: probes.branchExists,
    unrecordedWorktreeDirs: [] as string[], // needs the host's worktree root; the CLI cannot know it
    pidAlive: probes.pidAlive, pidStartedAtMs: probes.pidStartedAtMs, worktreeState: probes.worktreeState,
    dbSchemaVersion: dbVersion, extensionSchemaVersion: SCHEMA_VERSION,
    walBytes: probes.fileBytes(`${dbPath}-wal`), walLimitBytes: DOCTOR_WAL_LIMIT_BYTES,
    staleOutboxFiles: [] as string[], // scratch dirs are host-owned; the CLI cannot enumerate them
  };
}

function stuckProbes(store: Store, nowMs: number) {
  const tickets = (store.db.prepare(
    'SELECT id, key, stage_current, agent_state, archived_at, paused_at, updated_at FROM tickets',
  ).all() as TicketRow[]).map((t) => {
    const count = (sql: string): boolean => ((store.db.prepare(sql).get(t.id) as { n: number }).n > 0);
    return {
      id: t.id, key: t.key, stage: t.stage_current,
      updatedAtMs: parseDbTimeMs(t.updated_at),
      archived: t.archived_at !== null, paused: t.paused_at !== null,
      hasLiveSession: t.agent_state === 'running',
      hasRunningGate: count('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ? AND started_at IS NOT NULL AND ended_at IS NULL'),
      awaitingMerge: t.stage_current === 'ship',
      needsHumanRebase: count("SELECT COUNT(*) AS n FROM merge_checks WHERE ticket_id = ? AND state = 'conflicted'"),
      hasOpenBlockingSubtask: count("SELECT COUNT(*) AS n FROM tickets WHERE subtask_parent_id = ? AND blocks_parent = 1 AND stage_current IS NOT 'done'"),
    };
  });
  return { nowMs, thresholdMs: DOCTOR_STUCK_MINUTES * 60_000, tickets };
}

function runnableJs(p: string): boolean {
  try { return statSync(p).isFile() && p.endsWith('.js'); } catch { return false; }
}

function fixEffects(store: Store): FixEffects {
  return {
    markServerStopped: (id) => { store.db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(id); },
    pidStartedAtMs: probes.pidStartedAtMs,
    killProcess: (pid) => { process.kill(pid, 'SIGTERM'); },
    worktreeState: probes.worktreeState,
    pruneWorktree: (a) => {
      // No --force: git itself refuses a dirty tree. `branch -d` refuses unmerged work.
      execFileSync('git', ['-C', a.repo, 'worktree', 'remove', a.path], { stdio: 'ignore' });
      if (a.branch) { try { execFileSync('git', ['-C', a.repo, 'branch', '-d', a.branch], { stdio: 'ignore' }); } catch { /* unmerged branch is kept */ } }
      store.db.prepare('DELETE FROM worktrees WHERE ticket_id = ? AND path = ?').run(a.ticketId, a.path);
    },
    quarantineOutbox: () => { throw new Error('outbox quarantine is host-side only'); },
    recreateLauncher: () => { throw new Error('launcher is not available in this build'); },
  };
}

function collector(store: Store, dbPath: string, manifest: Manifest | undefined, manifestError: string | undefined, env: Readonly<Record<string, string | undefined>>) {
  return (areas: readonly DoctorArea[]): DoctorCheck[] => {
    const out: DoctorCheck[] = [];
    const nowMs = Date.now();
    if (areas.includes('tools')) {
      out.push(...checkTools({
        registry: dependencyRegistry('claude'), // the CLI has no host settings; claude is the default core
        probe: binaryExists, ready: commandSucceeds, readOutput: readCommandOutput, version: probes.toolVersion,
      }));
    }
    if (areas.includes('manifest')) {
      const live = new Set((store.db.prepare("SELECT pid FROM servers WHERE status = 'running' AND pid IS NOT NULL").all() as { pid: number }[]).map((r) => r.pid));
      out.push(...checkManifest({
        manifest, ...(manifestError ? { manifestError } : {}),
        pathExists: probes.pathExists, isGitRepo: probes.isGitRepo, branchExists: probes.branchExists, binaryResolves: probes.binaryResolves,
        portHolder: (port) => { const pids = probes.listeningPids(port); return pids.length === 0 ? 'free' : pids.every((p) => live.has(p)) ? 'karst' : 'foreign'; },
      }));
    }
    if (areas.includes('state')) {
      out.push(...checkState(stateProbes(store, dbPath)), ...checkStuckTickets(stuckProbes(store, nowMs)));
    }
    if (areas.includes('wiring')) {
      out.push(...checkWiring({ karstCli: env.KARST_CLI ?? process.argv[1], isRunnableJsFile: runnableJs }));
    }
    return out;
  };
}

/** `karst doctor` — read-only unless `--fix`. Throws `DoctorExit` so main sets the exit code. */
export function runDoctorCommand(
  store: Store,
  dbPath: string,
  manifestPath: string | undefined,
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): never {
  const args = parseDoctorArgs(rest);
  let manifest: Manifest | undefined;
  let manifestError: string | undefined;
  if (manifestPath) {
    try { manifest = loadManifestWithDiagnostics(manifestPath).manifest; }
    catch (e) { manifestError = (e as Error).message; }
  }
  const report = runDoctor({
    areas: args.areas, fix: args.fix,
    collect: collector(store, dbPath, manifest, manifestError, env),
    effects: fixEffects(store),
  });
  throw new DoctorExit(args.json ? JSON.stringify(report) : renderDoctorText(report), report.exitCode);
}
