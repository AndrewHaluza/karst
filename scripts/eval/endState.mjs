// What a finished attempt left in its karst.db: how it ended (evalPolicy.classifyEnd) and the
// karst metrics. Missing = null ('pending'), never 0 (@arch:PM-00): a metric whose source table has
// no rows for this run is reported pending, not as a measured zero.
import { spawnSync } from 'node:child_process';
import { classifyEnd } from '../uat-host/evalPolicy.mjs';

/** Opens read-only with node:sqlite (no native addon, so no Electron-ABI problem on the host). */
export async function openReadonly(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const TABLES = ['stage_runs', 'recovery_rounds', 'token_usage', 'process_runs', 'implementation_runs'];

/** {end, sources}: the classified run end, and row counts of each metric source table. */
export async function readRunState(dbPath, { timedOut = false } = {}) {
  const db = await openReadonly(dbPath);
  try {
    const ticket = db.prepare('SELECT id, stage_current FROM tickets ORDER BY id LIMIT 1').get();
    if (!ticket) throw new Error(`no ticket in ${dbPath}`);
    const stages = db
      .prepare('SELECT stage_key, status, blocked_kind, blocked_reason FROM stages WHERE ticket_id = ?')
      .all(ticket.id)
      .map((s) => ({ stageKey: s.stage_key, status: s.status, blockedKind: s.blocked_kind, blockedReason: s.blocked_reason }));
    const end = classifyEnd({ stageCurrent: ticket.stage_current, stages, timedOut });
    const sources = Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
    return { end, stages, sources };
  } finally {
    db.close();
  }
}

/** `karst stats --json` over the run's db (read-only CLI; needs dist/cli/main.js built). */
export function runStatsCli({ dbPath, cliEntry, node = process.execPath }) {
  const r = spawnSync(node, [cliEntry, 'stats', '--db', dbPath, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`karst stats failed (${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

const reviewRan = (stages) => stages.some((s) => s.stageKey === 'review' && (s.status === 'passed' || s.status === 'failed'));

/**
 * Flatten collectMetrics output into one attempt's metrics. Every field is a value or null.
 * `wallMs` is the runner's own clock (the db has no cycle time without a merged PR).
 */
export function attemptMetrics({ stats, sources, stages, wallMs }) {
  const ran = sources.stage_runs > 0;
  const agentRows = sources.process_runs + sources.implementation_runs;
  const tokenRows = sources.token_usage > 0;
  return {
    wallSeconds: wallMs === null || wallMs === undefined ? null : wallMs / 1000,
    agentActiveSeconds: agentRows > 0 ? (stats.agentActiveTime.processRunHours + stats.agentActiveTime.implementationRunHours) * 3600 : null,
    firstPassRate: ran ? stats.firstPass.overall.rate : null,
    reworkRounds: ran ? stats.rework.rounds : null,
    reviewFindings: reviewRan(stages) ? stats.findings.review.total : null,
    tokens: tokenRows
      ? {
          reportedTokens: stats.tokens.reportedTokens,
          estimatedTokens: stats.tokens.estimatedTokens,
          byCallSite: stats.tokens.byCallSite,
        }
      : null,
    // token_usage carries no price column, so a dollar figure would be invented, not read.
    costUsd: null,
  };
}
