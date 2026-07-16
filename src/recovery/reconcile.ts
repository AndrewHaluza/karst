import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { STAGE_KEYS } from '../model/types.js';
import { listTickets } from '../store/tickets.js';
import { setStage, type Stage } from '../store/stages.js';
import { isTerminal } from '../workflow/graph.js';
import { nowIso } from '../model/time.js';

/**
 * Crash recovery (§13, MVP §2.3). On reopen, SQLite is the source of truth: the
 * board is restored from `stages`, and servers recorded running-but-dead (they
 * die on window close in MVP) are deleted and surfaced for restart. Every stage
 * run is idempotent (§5.3), so an in-flight stage is safely re-runnable.
 */

/** Probes whether a pid is still alive (real: `process.kill(pid, 0)`); injected. */
export type IsAlive = (pid: number) => boolean;

export interface DeadServer {
  id: number;
  ticketId: number | null;
  service: string;
  pid: number | null;
}

export interface ReconcileResult {
  deadServers: DeadServer[];
}

/**
 * Derive a ticket's true `stage_current` from its stage rows — the authoritative
 * signal, in case the cached `stage_current` drifted across a crash. A running
 * stage wins; otherwise the *most recently touched* non-pending stage (by
 * timestamp, not graph-key order — the graph loops `fix→review`, so array index
 * is not monotonic with progress); a fresh ticket (all pending) sits at `scope`.
 */
export function deriveStageCurrent(stages: Stage[]): StageKey {
  const byKey = new Map(stages.map((s) => [s.stageKey, s]));

  const running = STAGE_KEYS.find((k) => byKey.get(k)?.status === 'running');
  if (running) return running;

  // Most recently touched non-pending stage. Recency = endedAt (a completed
  // stage) or startedAt (fallback). ISO-8601 strings sort lexicographically.
  let furthest: StageKey = 'scope';
  let latest = '';
  for (const k of STAGE_KEYS) {
    const s = byKey.get(k);
    if (!s || s.status === 'pending') continue;
    const ts = s.endedAt ?? s.startedAt ?? '';
    // `>=` so a later graph stage with an equal/empty timestamp still wins ties
    // in forward order, preserving prior behaviour for un-timestamped rows.
    if (ts >= latest) {
      latest = ts;
      furthest = k;
    }
  }
  return furthest;
}

/**
 * Close any terminal stage left 'running'. Nothing runs at a terminal stage and
 * no verdict can follow, so such a row can only come from a build that entered
 * it as running (fixed in machine.ts) — and those rows outlive the fix, leaving
 * a shipped ticket blue and filed under "In progress" forever. It ended when it
 * was entered, so the existing timestamp is kept rather than backdated to boot.
 * Returns the healed stages; the rows are patched through the single writer.
 */
function healTerminalStages(store: Store, ticketId: number, stages: Stage[]): Stage[] {
  return stages.map((s) => {
    if (!isTerminal(s.stageKey) || s.status !== 'running') return s;
    const endedAt = s.endedAt ?? s.startedAt ?? nowIso();
    setStage(store, ticketId, s.stageKey, { status: 'passed', endedAt });
    return { ...s, status: 'passed', endedAt };
  });
}

interface ServerRow {
  id: number;
  ticket_id: number | null;
  service: string;
  pid: number | null;
  status: string;
}

/**
 * Reconcile the world on start: rewrite each ticket's `stage_current` from its
 * stages, and delete every running-but-dead server row. Returns the dead
 * servers so the caller can offer them for restart.
 */
export function reconcileOnStart(store: Store, isAlive: IsAlive): ReconcileResult {
  const deadServers: DeadServer[] = [];

  const restore = store.db.transaction(() => {
    for (const ticket of listTickets(store)) {
      const stages = healTerminalStages(store, ticket.id, ticket.stages);
      const stage = deriveStageCurrent(stages);
      if (stage !== ticket.stageCurrent) {
        store.db
          .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
          .run(stage, ticket.id);
      }
    }

    const running = store.db
      .prepare("SELECT id, ticket_id, service, pid, status FROM servers WHERE status = 'running'")
      .all() as ServerRow[];

    // Mark dead 'running' rows as stopped (pid nulled) rather than deleting, so
    // a server that died while VS Code was closed surfaces on the dashboard as
    // offline and can be restarted. The deadServers list still reports them for
    // the restart offer.
    const markDead = store.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?");
    for (const row of running) {
      const alive = row.pid != null && isAlive(row.pid);
      if (!alive) {
        markDead.run(row.id);
        deadServers.push({
          id: row.id,
          ticketId: row.ticket_id,
          service: row.service,
          pid: row.pid,
        });
      }
    }
  });
  restore();

  return { deadServers };
}
