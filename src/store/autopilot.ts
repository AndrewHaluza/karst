import type { Store } from './db.js';

/**
 * Autopilot state (v100, T973): the per-ticket override, the stop/pause flags and one budget row per
 * (ticket, repo, kind). Store-only: nothing here runs git or gh.
 *
 * A PAUSED ticket (a round that started no session) is a different state from a SPENT budget: a pause costs no
 * attempt and is cleared only by a person (override change, approve-one-more, resume).
 */
/** v106 (T1019): one row per transient CI re-run. Not part of AUTOPILOT_DDL, whose v100 step already ran on old databases. */
export const AUTOPILOT_RERUNS_DDL = `
CREATE TABLE IF NOT EXISTS autopilot_reruns (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo       TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  check_name TEXT NOT NULL,
  head_sha   TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  rerun_at   INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, repo, run_id, check_name)
);
`;

export const AUTOPILOT_DDL = `
CREATE TABLE IF NOT EXISTS autopilot_tickets (
  ticket_id     INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'inherit' CHECK (mode IN ('inherit', 'on', 'off')),
  stop_after    INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  stopped_reason TEXT,
  claim_owner   TEXT,
  claim_until   INTEGER,
  session_owner TEXT,
  conflict_round_at INTEGER
);
CREATE TABLE IF NOT EXISTS autopilot_budgets (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  repo      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('conflicts', 'ci')),
  attempts  INTEGER NOT NULL DEFAULT 0,
  signature TEXT,
  extra     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, repo, kind)
);
`;

export type AutopilotOverride = 'inherit' | 'on' | 'off';
export type AutopilotKind = 'conflicts' | 'ci';

export const AUTOPILOT_OVERRIDES: readonly AutopilotOverride[] = ['inherit', 'on', 'off'];

export interface AutopilotTicketState {
  readonly mode: AutopilotOverride;
  readonly stopAfter: boolean;
  readonly pausedReason: string | null;
  readonly stoppedReason: string | null;
}

interface TicketRow { mode: AutopilotOverride; stop_after: number; paused_reason: string | null; stopped_reason: string | null }

export function getAutopilotTicket(store: Store, ticketId: number): AutopilotTicketState {
  const row = store.db.prepare('SELECT mode, stop_after, paused_reason, stopped_reason FROM autopilot_tickets WHERE ticket_id = ?').get(ticketId) as TicketRow | undefined;
  return { mode: row?.mode ?? 'inherit', stopAfter: (row?.stop_after ?? 0) === 1, pausedReason: row?.paused_reason ?? null, stoppedReason: row?.stopped_reason ?? null };
}

function ensureRow(store: Store, ticketId: number): void {
  store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)').run(ticketId);
}

/** Set the override. A change is a person's decision, so it also clears the stop flag and a pause. */
export function setAutopilotOverride(store: Store, ticketId: number, mode: AutopilotOverride): void {
  if (!AUTOPILOT_OVERRIDES.includes(mode)) throw new Error(`autopilot override must be one of ${AUTOPILOT_OVERRIDES.join(', ')}`);
  ensureRow(store, ticketId);
  store.db.prepare('UPDATE autopilot_tickets SET mode = ?, stop_after = 0, paused_reason = NULL, stopped_reason = NULL WHERE ticket_id = ?').run(mode, ticketId);
}

/** Remember the park reason last written, so a repeat tick does not repeat the note. Null clears it. */
export function setAutopilotStopped(store: Store, ticketId: number, reason: string | null): void {
  ensureRow(store, ticketId);
  store.db.prepare('UPDATE autopilot_tickets SET stopped_reason = ? WHERE ticket_id = ?').run(reason, ticketId);
}

/** A conflict round was sent at `atMs`: it holds a sub-task slot until it delivers, stops or is dropped (`HOLDS_SLOT_SQL`). */
export function markConflictRound(store: Store, ticketId: number, atMs: number): void {
  ensureRow(store, ticketId);
  store.db.prepare('UPDATE autopilot_tickets SET conflict_round_at = ? WHERE ticket_id = ?').run(atMs, ticketId);
}

/** When the engine sent its conflict round (ms), or null. A manual Resolve conflicts click leaves it null. */
export function getConflictRoundAt(store: Store, ticketId: number): number | null {
  const row = store.db.prepare('SELECT conflict_round_at AS at FROM autopilot_tickets WHERE ticket_id = ?').get(ticketId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** The conflict round ended (delivered, dropped or stopped): its slot is free. */
export function clearConflictRound(store: Store, ticketId: number): void {
  store.db.prepare('UPDATE autopilot_tickets SET conflict_round_at = NULL WHERE ticket_id = ?').run(ticketId);
}

/** Give back an attempt that never reached the agent (a failed action). Never below zero. */
export function refundAutopilotAttempt(store: Store, ticketId: number, repo: string, kind: AutopilotKind): void {
  store.db.prepare('UPDATE autopilot_budgets SET attempts = MAX(attempts - 1, 0) WHERE ticket_id = ? AND repo = ? AND kind = ?').run(ticketId, repo, kind);
}

/** "Stop after this round": no new round is armed until a person changes the override. */
export function setAutopilotStopAfter(store: Store, ticketId: number): void {
  ensureRow(store, ticketId);
  store.db.prepare('UPDATE autopilot_tickets SET stop_after = 1 WHERE ticket_id = ?').run(ticketId);
}

export function setAutopilotPaused(store: Store, ticketId: number, reason: string | null): void {
  ensureRow(store, ticketId);
  store.db.prepare('UPDATE autopilot_tickets SET paused_reason = ? WHERE ticket_id = ?').run(reason, ticketId);
}

/**
 * The effective mode of a ticket: its own override, else (for a sub-task) the parent's effective mode,
 * else the manifest default. `inherit` walks up; the walk is bounded so a corrupt parent cycle ends.
 */
export function effectiveAutopilot(store: Store, ticketId: number, manifestEnabled: boolean): boolean {
  const seen = new Set<number>();
  let id: number | null = ticketId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const { mode } = getAutopilotTicket(store, id);
    if (mode !== 'inherit') return mode === 'on';
    const row = store.db.prepare('SELECT subtask_parent_id AS parent FROM tickets WHERE id = ?').get(id) as { parent: number | null } | undefined;
    id = row?.parent ?? null;
  }
  return manifestEnabled;
}

export interface AutopilotBudget {
  readonly attempts: number;
  readonly signature: string | null;
  readonly extra: number;
}

interface BudgetRow { attempts: number; signature: string | null; extra: number }

export function getAutopilotBudget(store: Store, ticketId: number, repo: string, kind: AutopilotKind): AutopilotBudget {
  const row = store.db.prepare('SELECT attempts, signature, extra FROM autopilot_budgets WHERE ticket_id = ? AND repo = ? AND kind = ?').get(ticketId, repo, kind) as BudgetRow | undefined;
  return { attempts: row?.attempts ?? 0, signature: row?.signature ?? null, extra: row?.extra ?? 0 };
}

export type BudgetDecision =
  | { readonly ok: true; readonly used: number; readonly max: number }
  | { readonly ok: false; readonly used: number; readonly max: number };

/**
 * Pure budget rule. A changed signature resets the counter and the granted extras (a different problem);
 * the same signature after an attempt keeps counting (the loop guard).
 */
export function decideBudget(prev: AutopilotBudget, signature: string, maxBase: number): { next: AutopilotBudget; decision: BudgetDecision } {
  const base: AutopilotBudget = prev.signature === signature ? prev : { attempts: 0, signature, extra: 0 };
  const max = maxBase + base.extra;
  if (base.attempts >= max) return { next: base, decision: { ok: false, used: base.attempts, max } };
  const next = { ...base, attempts: base.attempts + 1 };
  return { next, decision: { ok: true, used: next.attempts, max } };
}

function writeBudget(store: Store, ticketId: number, repo: string, kind: AutopilotKind, b: AutopilotBudget): void {
  store.db
    .prepare(
      `INSERT INTO autopilot_budgets (ticket_id, repo, kind, attempts, signature, extra) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (ticket_id, repo, kind) DO UPDATE SET attempts = excluded.attempts, signature = excluded.signature, extra = excluded.extra`,
    )
    .run(ticketId, repo, kind, b.attempts, b.signature, b.extra);
}

/** Spend one attempt when the budget allows it. The write is one transaction, so two windows cannot both take the last attempt. */
export function takeAutopilotAttempt(store: Store, ticketId: number, repo: string, kind: AutopilotKind, signature: string, maxBase: number): BudgetDecision {
  const run = store.db.transaction((): BudgetDecision => {
    const { next, decision } = decideBudget(getAutopilotBudget(store, ticketId, repo, kind), signature, maxBase);
    writeBudget(store, ticketId, repo, kind, next);
    return decision;
  });
  return run();
}

/** A one-off +1 for this PR and kind. It never resets `attempts`. Also clears a pause and the stop flag (a person decided). */
export function grantAutopilotExtra(store: Store, ticketId: number, repo: string, kind: AutopilotKind): AutopilotBudget {
  const run = store.db.transaction((): AutopilotBudget => {
    const cur = getAutopilotBudget(store, ticketId, repo, kind);
    const next = { ...cur, extra: cur.extra + 1 };
    writeBudget(store, ticketId, repo, kind, next);
    ensureRow(store, ticketId);
    store.db.prepare('UPDATE autopilot_tickets SET paused_reason = NULL, stopped_reason = NULL, stop_after = 0 WHERE ticket_id = ?').run(ticketId);
    return next;
  });
  return run();
}

/** The park reason for a spent budget. */
export function stoppedReason(kind: AutopilotKind, used: number, max: number): string {
  return `auto-fix stopped: ${kind} ${used}/${max}`;
}

/** The (repo, kind) pairs a ticket has a budget for, oldest first. Used to pick the target of "Approve 1 more". */
export function listAutopilotBudgets(store: Store, ticketId: number): Array<{ repo: string; kind: AutopilotKind }> {
  return store.db.prepare('SELECT repo, kind FROM autopilot_budgets WHERE ticket_id = ? ORDER BY rowid').all(ticketId) as Array<{ repo: string; kind: AutopilotKind }>;
}

/**
 * Two windows share one database. The controller of a ticket claims it for a short lease; the claim is
 * atomic (one UPDATE), and the owner renews it. Returns true when `owner` holds the lease after the call.
 */
export function claimAutopilotTicket(store: Store, ticketId: number, owner: string, nowMs: number, ttlMs: number): boolean {
  const run = store.db.transaction((): boolean => {
    store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) VALUES (?)').run(ticketId);
    const r = store.db.prepare('UPDATE autopilot_tickets SET claim_owner = ?, claim_until = ? WHERE ticket_id = ? AND (claim_owner IS NULL OR claim_owner = ? OR claim_until IS NULL OR claim_until <= ?)')
      .run(owner, nowMs + ttlMs, ticketId, owner, nowMs);
    return r.changes > 0;
  });
  return run();
}

/**
 * Record which window holds the live session of each owned ticket, and drop this window's claim on a ticket
 * it no longer owns. Another window's claim is never touched. Call it after every change of the owned set.
 */
export function syncAutopilotSessionOwner(store: Store, windowId: string, ownedTicketIds: readonly number[]): void {
  const run = store.db.transaction((): void => {
    const set = store.db.prepare('INSERT OR IGNORE INTO autopilot_tickets (ticket_id) SELECT id FROM tickets WHERE id = ?');
    const claim = store.db.prepare('UPDATE autopilot_tickets SET session_owner = ? WHERE ticket_id = ?');
    for (const id of ownedTicketIds) { set.run(id); claim.run(windowId, id); }
    const mine = store.db.prepare('SELECT ticket_id AS id FROM autopilot_tickets WHERE session_owner = ?').all(windowId) as Array<{ id: number }>;
    const release = store.db.prepare('UPDATE autopilot_tickets SET session_owner = NULL WHERE ticket_id = ? AND session_owner = ?');
    for (const { id } of mine) if (!ownedTicketIds.includes(id)) release.run(id, windowId);
  });
  run();
}

/** The window that holds the ticket's session, or null when the store names none. */
export function getAutopilotSessionOwner(store: Store, ticketId: number): string | null {
  const row = store.db.prepare('SELECT session_owner AS owner FROM autopilot_tickets WHERE ticket_id = ?').get(ticketId) as { owner: string | null } | undefined;
  return row?.owner ?? null;
}

/** A transient CI re-run the engine started (T1019). One per (ticket, repo, run, check): a run id belongs to one head. */
export interface AutopilotRerun {
  readonly repo: string;
  readonly runId: string;
  readonly checkName: string;
  readonly headSha: string;
  readonly pattern: string;
  readonly rerunAt: number;
}

/** Record a re-run. False when the row exists (a reload or a second window already re-ran this check): the caller must not re-run. */
export function markAutopilotRerun(store: Store, ticketId: number, r: AutopilotRerun): boolean {
  return store.db
    .prepare('INSERT OR IGNORE INTO autopilot_reruns (ticket_id, repo, run_id, check_name, head_sha, pattern, rerun_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ticketId, r.repo, r.runId, r.checkName, r.headSha, r.pattern, r.rerunAt).changes === 1;
}

/** The earlier re-run of this check on this run, or null. */
export function getAutopilotRerun(store: Store, ticketId: number, repo: string, runId: string, checkName: string): AutopilotRerun | null {
  const row = store.db
    .prepare('SELECT repo, run_id AS runId, check_name AS checkName, head_sha AS headSha, pattern, rerun_at AS rerunAt FROM autopilot_reruns WHERE ticket_id = ? AND repo = ? AND run_id = ? AND check_name = ?')
    .get(ticketId, repo, runId, checkName) as AutopilotRerun | undefined;
  return row ?? null;
}
