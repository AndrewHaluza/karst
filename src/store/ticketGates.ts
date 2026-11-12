import type { Store } from './db.js';
import { runImmediateTransaction } from './transactions.js';

/**
 * The stages whose gate list a ticket may cut. Deliberately narrower than
 * `StageKey`: only `uat` and `review` resolve gates at all, so a wider type
 * would let a caller ask a question that has no answer.
 */
export const GATE_STAGES = ['uat', 'review'] as const;
export type GateStage = (typeof GATE_STAGES)[number];

/**
 * The stages that own a console: the gate stages plus `ship`, whose auto-deliver
 * gate run streams live output (T1018, @arch:GATE-OUTPUT). `ship` has no stage
 * artifact; its post-run console reads the kept `deliver_gate_results` summaries.
 */
export const CONSOLE_STAGES = ['uat', 'review', 'ship'] as const;
export type ConsoleStage = (typeof CONSOLE_STAGES)[number];

/**
 * Which named gates this ticket has switched off, per stage.
 *
 * An empty array is the whole meaning of "nothing disabled" — there is no
 * separate absent state, exactly as an absent `tickets.model` means "inherit".
 * The lists are gate NAMES, matched against `ResolvedGate.name` after
 * resolution; they never name a command, so a disable can never smuggle one in.
 */
export interface DisabledGates {
  uat: readonly string[];
  review: readonly string[];
}

const EMPTY: DisabledGates = { uat: [], review: [] };

/** Names, trimmed, de-blanked and deduplicated, order preserved. */
function normalizeNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Parse the stored JSON, tolerating bad data — same house convention as
 * `parseArgs` in `gateRuns.ts` and `parseSelectedRepos` in `tickets.ts`: data
 * this module writes is always well-formed, so this guards the boundary, not
 * the writer. A corrupted column must degrade to "nothing disabled" (which runs
 * MORE gates, never fewer) rather than take the stage or the panel down.
 */
function parseDisabled(raw: string | null): DisabledGates {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY;
    const obj = parsed as Record<string, unknown>;
    const pick = (stage: GateStage): string[] =>
      Array.isArray(obj[stage]) ? normalizeNames(obj[stage] as unknown[]) : [];
    return { uat: pick('uat'), review: pick('review') };
  } catch {
    return EMPTY;
  }
}

/** What this ticket has switched off. Never throws; an unknown id reads empty. */
export function getDisabledGates(store: Store, ticketId: number): DisabledGates {
  const row = store.db
    .prepare('SELECT disabled_gates FROM tickets WHERE id = ?')
    .get(ticketId) as { disabled_gates: string | null } | undefined;
  return row ? parseDisabled(row.disabled_gates) : EMPTY;
}

/**
 * Replace ONE stage's list, leaving the other stage's exactly as it was.
 *
 * Scoped like the settings page's per-section save, and for the same reason: a
 * whole-object write from a panel that loaded before the other stage was
 * touched would silently revert it. The current value is re-read here, inside
 * the same statement pair, rather than trusted from the caller.
 *
 * That re-read and the write run in ONE `BEGIN IMMEDIATE` transaction: the
 * per-stage merge is only safe if no other window commits between them, so
 * without it two IDE windows editing different stages of the same ticket can
 * lose each other's list (last writer reverts). The transaction makes the
 * read-modify-write atomic across processes, not just within one (P2-03).
 */
export function setDisabledGates(
  store: Store,
  ticketId: number,
  stage: GateStage,
  names: readonly string[],
): void {
  const normalized = normalizeNames(names);
  runImmediateTransaction(store.db, () => {
    const current = getDisabledGates(store, ticketId);
    const next: DisabledGates = { ...current, [stage]: normalized };
    // NULL rather than `{"uat":[],"review":[]}` when nothing is disabled: the
    // column's absent state and its empty state mean the same thing, and storing
    // one canonical form keeps every reader from having to know both.
    const empty = next.uat.length === 0 && next.review.length === 0;
    store.db
      .prepare("UPDATE tickets SET disabled_gates = ?, updated_at = datetime('now') WHERE id = ?")
      .run(empty ? null : JSON.stringify({ uat: next.uat, review: next.review }), ticketId);
  });
}

/** Gate names this ticket reruns on the host after a resource kill. Never throws; bad data reads empty. */
export function getHostGates(store: Store, ticketId: number): readonly string[] {
  const row = store.db.prepare('SELECT host_gates FROM tickets WHERE id = ?').get(ticketId) as
    | { host_gates: string | null }
    | undefined;
  if (!row?.host_gates) return [];
  try {
    const parsed: unknown = JSON.parse(row.host_gates);
    return Array.isArray(parsed) ? normalizeNames(parsed) : [];
  } catch {
    return [];
  }
}

/** Add gate names to the host list (merged inside one transaction, like `setDisabledGates`). */
export function addHostGates(store: Store, ticketId: number, names: readonly string[]): void {
  runImmediateTransaction(store.db, () => {
    const next = normalizeNames([...getHostGates(store, ticketId), ...names]);
    store.db
      .prepare("UPDATE tickets SET host_gates = ?, updated_at = datetime('now') WHERE id = ?")
      .run(next.length === 0 ? null : JSON.stringify(next), ticketId);
  });
}

/**
 * The gate names a ticket's branch was cut with, per stage (@arch:GATE-SNAPSHOT).
 *
 * A stage that is `null` was not captured (the first gate run of that stage takes
 * it); every resolved gate of such a stage runs. An empty array is a real snapshot:
 * the branch started with no gate for that stage. The whole column NULL reads as
 * `null`.
 */
export interface GateSnapshot {
  uat: readonly string[] | null;
  review: readonly string[] | null;
}

export function getGateSnapshot(store: Store, ticketId: number): GateSnapshot | null {
  const row = store.db
    .prepare('SELECT gate_snapshot FROM tickets WHERE id = ?')
    .get(ticketId) as { gate_snapshot: string | null } | undefined;
  if (!row || row.gate_snapshot === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.gate_snapshot);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const pick = (stage: GateStage): string[] | null =>
      Array.isArray(obj[stage]) ? normalizeNames(obj[stage] as unknown[]) : null;
    return { uat: pick('uat'), review: pick('review') };
  } catch {
    // A corrupt column degrades to "no snapshot": more gates run, never fewer.
    return null;
  }
}

/** One stage's snapshot names; null when the ticket has none for that stage. */
export function getStageGateSnapshot(store: Store, ticketId: number, stage: GateStage): readonly string[] | null {
  return getGateSnapshot(store, ticketId)?.[stage] ?? null;
}

/** Replace the whole snapshot (a rebase re-states every stage at once). */
export function setGateSnapshot(
  store: Store,
  ticketId: number,
  snapshot: { uat: readonly string[]; review: readonly string[] },
): void {
  store.db
    .prepare("UPDATE tickets SET gate_snapshot = ?, updated_at = datetime('now') WHERE id = ?")
    .run(
      JSON.stringify({ uat: normalizeNames(snapshot.uat), review: normalizeNames(snapshot.review) }),
      ticketId,
    );
}

/** Capture ONE stage, leaving the other as it was (read-modify-write in one transaction, like `setDisabledGates`). */
export function setStageGateSnapshot(
  store: Store,
  ticketId: number,
  stage: GateStage,
  names: readonly string[],
): void {
  runImmediateTransaction(store.db, () => {
    const current = getGateSnapshot(store, ticketId) ?? { uat: null, review: null };
    const next = { ...current, [stage]: normalizeNames(names) };
    store.db
      .prepare("UPDATE tickets SET gate_snapshot = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(next), ticketId);
  });
}
