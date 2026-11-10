import type { Store } from '../../store/db.js';
import type { TicketEvidence } from './runner.js';

interface TicketRow { id: number; key: string; title: string; stage_current: string }
interface StageRow { ticket_id: number; stage_key: string; status: string; blocked_kind: string | null }

interface GateRow { ticket_id: number; stage_key: string; attempt: number; gate_name: string; exit_code: number | null }
interface ProcessRow { ticket_id: number; stage_key: string; process_id: string; attempt: number; status: string }
interface FindingRow { ticket_id: number; attempt: number; severity: string; repo: string; file: string | null; line: number | null; title: string }
interface MergeRow { ticket_id: number; repo: string; state: string; files: string; head_sha: string | null; base_sha: string | null; base_ref: string | null }

function parseFiles(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/** Ticket and stage rows with no timestamps or ids, ordered so the JSON is stable across runs. */
export function readTickets(store: Store): TicketEvidence[] {
  const tickets = store.db.prepare('SELECT id, key, title, stage_current FROM tickets ORDER BY key').all() as TicketRow[];
  const stages = store.db
    .prepare('SELECT ticket_id, stage_key, status, blocked_kind FROM stages ORDER BY ticket_id, stage_key')
    .all() as StageRow[];
  const gates = store.db
    .prepare('SELECT ticket_id, stage_key, attempt, gate_name, exit_code FROM gate_runs ORDER BY ticket_id, id')
    .all() as GateRow[];
  const processes = store.db
    .prepare('SELECT ticket_id, stage_key, process_id, attempt, status FROM process_runs ORDER BY ticket_id, id')
    .all() as ProcessRow[];
  const findings = store.db
    .prepare('SELECT ticket_id, attempt, severity, repo, file, line, title FROM review_findings ORDER BY ticket_id, id')
    .all() as FindingRow[];
  const merges = store.db
    .prepare('SELECT ticket_id, repo, state, files, head_sha, base_sha, base_ref FROM merge_checks ORDER BY ticket_id, repo')
    .all() as MergeRow[];
  return tickets.map((t) => ({
    key: t.key,
    title: t.title,
    stage: t.stage_current,
    stages: stages
      .filter((s) => s.ticket_id === t.id)
      .map((s) => ({ stage: s.stage_key, status: s.status, blockedKind: s.blocked_kind })),
    gateRuns: gates
      .filter((g) => g.ticket_id === t.id)
      .map((g) => ({ stage: g.stage_key, attempt: g.attempt, gate: g.gate_name, exitCode: g.exit_code })),
    processRuns: processes
      .filter((p) => p.ticket_id === t.id)
      .map((p) => ({ stage: p.stage_key, process: p.process_id, attempt: p.attempt, status: p.status })),
    reviewFindings: findings
      .filter((f) => f.ticket_id === t.id)
      .map((f) => ({ attempt: f.attempt, severity: f.severity, repo: f.repo, file: f.file, line: f.line, title: f.title })),
    mergeChecks: merges
      .filter((m) => m.ticket_id === t.id)
      .map((m) => ({ repo: m.repo, state: m.state, files: parseFiles(m.files), headSha: m.head_sha, baseSha: m.base_sha, baseRef: m.base_ref })),
  }));
}
