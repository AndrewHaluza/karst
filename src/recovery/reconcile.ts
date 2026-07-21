import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { STAGE_KEYS } from '../model/types.js';
import { listTickets } from '../store/tickets.js';
import { setStage, type Stage } from '../store/stages.js';
import { isTerminal, needsConfirm } from '../workflow/graph.js';
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
    // `pending` alone does not mean untouched: a confirm stage parks as pending
    // the moment it is entered, and skipping it walked a ticket waiting on the
    // user backwards to the stage it came from. `startedAt` is what separates a
    // stage that was ENTERED from one nothing has ever reached.
    if (!s || (s.status === 'pending' && s.startedAt === null)) continue;
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
 * Repair stage rows that can only be 'running' because an older build entered
 * them that way (both entry rules now live in machine.ts's `entryPatch`). Such
 * rows outlive the fix that produced them, so boot has to heal them or the
 * ticket is stuck with the wrong glyph forever.
 *
 * - Terminal: nothing runs there and no verdict can follow, so it is complete.
 *   It ended when it was entered — keep that timestamp rather than backdating to
 *   boot. Left alone, a shipped ticket stays blue and filed under "In progress".
 * - Confirm: it cannot be mid-run across a restart, because the click that starts
 *   it is a live user action and the process that would have been shipping is
 *   gone. Park it so it reads as needs-you instead of claiming to be working.
 *
 * Only 'running' rows are touched: a `failed` ship keeps its verdict and stays
 * blocked, which is a different (and already correct) answer.
 *
 * Returns the healed stages; rows are patched through the single writer.
 */
function healEntryStages(store: Store, ticketId: number, stages: Stage[]): Stage[] {
  return stages.map((s) => {
    if (s.status !== 'running') return s;

    if (isTerminal(s.stageKey)) {
      const endedAt = s.endedAt ?? s.startedAt ?? nowIso();
      setStage(store, ticketId, s.stageKey, { status: 'passed', endedAt });
      return { ...s, status: 'passed', endedAt };
    }

    if (needsConfirm(s.stageKey)) {
      const startedAt = s.startedAt ?? nowIso();
      setStage(store, ticketId, s.stageKey, { status: 'pending', startedAt, endedAt: null });
      return { ...s, status: 'pending', startedAt, endedAt: null };
    }

    return s;
  });
}

interface ServerRow {
  id: number;
  ticket_id: number | null;
  repo: string;
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
      const stages = healEntryStages(store, ticket.id, ticket.stages);
      const stage = deriveStageCurrent(stages);
      if (stage !== ticket.stageCurrent) {
        store.db
          .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
          .run(stage, ticket.id);
      }
    }

    const running = store.db
      .prepare("SELECT id, ticket_id, repo, pid, status FROM servers WHERE status = 'running'")
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
          service: row.repo,
          pid: row.pid,
        });
      }
    }
  });
  restore();

  return { deadServers };
}
