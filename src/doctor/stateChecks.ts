/**
 * `state.*` doctor checks: karst-owned state (worktrees, servers, schema, WAL,
 * outbox) compared against the machine. PURE — every probe arrives as plain
 * data or a function, so tests need no DB and no disk.
 *
 * Auto fixes are issued only where the DB proves the action safe. Anything
 * that could touch live work (dirty trees, reused pids) is a report fix.
 */

import type { DoctorCheck, DoctorFix } from './types.js';

export interface WorktreeProbe {
  ticketId: number;
  ticketKey: string;
  ticketStage: string | null;
  repo: string;
  path: string;
  branch: string | null;
}

export interface ServerProbe {
  id: number;
  ticketId: number | null;
  ticketStage: string | null;
  repo: string;
  port: number | null;
  pid: number | null;
  status: string;
  /** SQLite `datetime('now')` (UTC, `YYYY-MM-DD HH:MM:SS`) or ISO. */
  startedAt: string;
  kind: string;
}

export interface StateProbes {
  worktrees: WorktreeProbe[];
  servers: ServerProbe[];
  pathExists: (p: string) => boolean;
  branchExists: (repo: string, branch: string) => boolean;
  /** git worktrees actually present on disk under karst's worktree root, not recorded in DB. */
  unrecordedWorktreeDirs: string[];
  pidAlive: (pid: number) => boolean;
  /** For pid-reuse guard: process start time (epoch ms) or undefined if unknowable. */
  pidStartedAtMs: (pid: number) => number | undefined;
  /** worktree cleanliness for prune: 'clean' = no uncommitted AND no unpushed; 'dirty'; 'unknown'. */
  worktreeState: (path: string) => 'clean' | 'dirty' | 'unknown';
  dbSchemaVersion: number;
  extensionSchemaVersion: number;
  walBytes: number;
  walLimitBytes: number;
  /** Outbox files never ingested, older than the caller's age cutoff. */
  staleOutboxFiles: string[];
}

/** The only terminal ticket stage (see `StageKey` in `src/model/types.ts`). */
const TERMINAL_STAGE = 'done';

/** A process started at most this long after the server row was written is the same process. */
const PID_REUSE_SLACK_MS = 5000;

const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

function ok(id: string, detail: string): DoctorCheck {
  return { id, area: 'state', status: 'ok', detail };
}

function warn(id: string, detail: string, fix: DoctorFix): DoctorCheck {
  return { id, area: 'state', status: 'warn', detail, fix };
}

function fail(id: string, detail: string, fix: DoctorFix): DoctorCheck {
  return { id, area: 'state', status: 'fail', detail, fix };
}

/** Parse a recorded start time as UTC. Undefined when it is not a valid date. */
export function parseRecordedUtc(value: string): number | undefined {
  const m = SQLITE_UTC.exec(value);
  const ms = Date.parse(m ? `${m[1]}T${m[2]}Z` : value);
  return Number.isNaN(ms) ? undefined : ms;
}

function worktreePruneCheck(p: StateProbes, w: WorktreeProbe): DoctorCheck {
  const id = `state.worktree-prune.${w.ticketKey}.${w.repo}`;
  const verdict = p.worktreeState(w.path);
  if (verdict === 'clean') {
    return warn(id, `Ticket ${w.ticketKey} is done and the ${w.repo} worktree is clean; it can be pruned.`, {
      tier: 'auto',
      summary: `Prune clean worktree ${w.path}`,
      action: {
        kind: 'prune-worktree',
        ticketId: w.ticketId,
        repo: w.repo,
        path: w.path,
        branch: w.branch,
      },
    });
  }
  return warn(id, `Ticket ${w.ticketKey} is done but the ${w.repo} worktree is ${verdict}; not pruned automatically.`, {
    tier: 'report',
    summary: `Worktree ${w.path} is ${verdict}`,
    nextStep: `Commit, push, or discard the changes in ${w.path}, then archive or remove it from the dashboard.`,
  });
}

function worktreeChecks(p: StateProbes, w: WorktreeProbe): DoctorCheck[] {
  const key = `${w.ticketKey}.${w.repo}`;
  if (!p.pathExists(w.path)) {
    return [
      warn(`state.worktree-missing.${key}`, `Worktree for ${w.ticketKey} (${w.repo}) is recorded at ${w.path} but the folder is gone.`, {
        tier: 'report',
        summary: `Worktree folder ${w.path} is missing`,
        nextStep: `Re-cut ${w.ticketKey} for ${w.repo} from the dashboard, or archive the ticket there.`,
      }),
    ];
  }
  const checks: DoctorCheck[] = [];
  if (w.branch !== null && !p.branchExists(w.repo, w.branch)) {
    checks.push(
      warn(`state.worktree-branch-missing.${key}`, `Branch ${w.branch} recorded for ${w.ticketKey} (${w.repo}) does not exist.`, {
        tier: 'report',
        summary: `Branch ${w.branch} is missing`,
        nextStep: `Re-cut ${w.ticketKey} for ${w.repo} from the dashboard, or archive the ticket there.`,
      }),
    );
  }
  if (w.ticketStage === TERMINAL_STAGE) {
    checks.push(worktreePruneCheck(p, w));
  }
  return checks;
}

function unrecordedCheck(dir: string, index: number): DoctorCheck {
  return warn(`state.worktree-unrecorded.${index}`, `Worktree folder ${dir} exists on disk but is not recorded in karst.`, {
    tier: 'report',
    summary: `Unrecorded worktree ${dir}`,
    nextStep: `If ${dir} is not needed, remove it with \`git worktree remove\`; otherwise leave it.`,
  });
}

function deadServerCheck(s: ServerProbe): DoctorCheck {
  return warn(`state.server-dead.${s.id}`, `Server ${s.id} (${s.repo}) is marked running but its process is gone.`, {
    tier: 'auto',
    summary: `Mark server ${s.id} stopped`,
    action: { kind: 'mark-server-stopped', serverId: s.id, pid: s.pid },
  });
}

function leakedServerCheck(p: StateProbes, s: ServerProbe, pid: number): DoctorCheck {
  const id = `state.server-leaked.${s.id}`;
  const startedMs = p.pidStartedAtMs(pid);
  const recordedMs = parseRecordedUtc(s.startedAt);
  if (startedMs !== undefined && recordedMs !== undefined && startedMs <= recordedMs + PID_REUSE_SLACK_MS) {
    return warn(id, `Server ${s.id} (${s.repo}) belongs to done ticket ${s.ticketId}; its process ${pid} is still running.`, {
      tier: 'auto',
      summary: `Kill leaked server process ${pid}`,
      action: { kind: 'kill-process', serverId: s.id, pid, startedAt: s.startedAt },
    });
  }
  return warn(id, `Process ${pid} for server ${s.id} started after the server was recorded, or its start time is unknown; the pid may be reused.`, {
    tier: 'report',
    summary: `Pid ${pid} is not verifiably server ${s.id}`,
    nextStep: `Check \`ps -p ${pid} -o command=\`; if it is the karst server, stop it manually.`,
  });
}

function serverChecks(p: StateProbes, s: ServerProbe): DoctorCheck[] {
  if (s.status !== 'running') return [];
  if (s.pid === null || !p.pidAlive(s.pid)) return [deadServerCheck(s)];
  if (s.ticketId === null || s.ticketStage !== TERMINAL_STAGE) return [];
  return [leakedServerCheck(p, s, s.pid)];
}

function schemaCheck(p: StateProbes): DoctorCheck {
  if (p.dbSchemaVersion === p.extensionSchemaVersion) {
    return ok('state.schema', `Database schema v${p.dbSchemaVersion} matches the extension.`);
  }
  return fail(
    'state.schema',
    `Database schema v${p.dbSchemaVersion} does not match extension schema v${p.extensionSchemaVersion}.`,
    {
      tier: 'report',
      summary: 'Database and extension schema versions differ',
      nextStep: 'Update the karst extension to match the database, or reload the VS Code window so the matching version runs.',
    },
  );
}

function walCheck(p: StateProbes): DoctorCheck {
  if (p.walBytes <= p.walLimitBytes) {
    return ok('state.wal', `SQLite WAL is ${p.walBytes} bytes, within the ${p.walLimitBytes} byte limit.`);
  }
  return warn('state.wal', `SQLite WAL is ${p.walBytes} bytes, over the ${p.walLimitBytes} byte limit.`, {
    tier: 'report',
    summary: 'SQLite WAL is oversized',
    nextStep: 'Run a checkpoint by closing all karst windows.',
  });
}

function outboxCheck(path: string, index: number): DoctorCheck {
  return warn(`state.outbox.${index}`, `Outbox file ${path} was never ingested and is stale.`, {
    tier: 'auto',
    summary: `Quarantine stale outbox file ${path}`,
    action: { kind: 'quarantine-outbox', path },
  });
}

/** An ok summary, emitted only when the section has no findings. */
function summarize(id: string, findings: DoctorCheck[], detail: string): DoctorCheck[] {
  return findings.length === 0 ? [ok(id, detail)] : [];
}

export function checkState(p: StateProbes): DoctorCheck[] {
  const worktreeFindings = [
    ...p.worktrees.flatMap((w) => worktreeChecks(p, w)),
    ...p.unrecordedWorktreeDirs.map(unrecordedCheck),
  ];
  const serverFindings = p.servers.flatMap((s) => serverChecks(p, s));
  return [
    ...summarize('state.worktrees', worktreeFindings, `${p.worktrees.length} recorded worktree(s) checked; none need attention.`),
    ...worktreeFindings,
    ...summarize('state.servers', serverFindings, `${p.servers.length} server row(s) checked; none dead or leaked.`),
    ...serverFindings,
    schemaCheck(p),
    walCheck(p),
    ...p.staleOutboxFiles.map(outboxCheck),
  ];
}
