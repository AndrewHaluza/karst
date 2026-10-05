import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.js';
import { STAGE_KEYS, type StageKey } from '../model/types.js';
import { rowToStage, setStage, type Stage } from './stages.js';
import { renderTicketLabel } from './ticketLabelTemplate.js';
import type { AgentProvider } from '../manifest/types.js';
// `provider.js`, not `registry.js`: the re-export still works, but importing the
// registry pulls the launch adapters (and `node:child_process`) into every
// consumer of this module — the edge `diagnostics/nonInterference.test.ts` bans.
import { isKnownProvider } from '../agent/provider.js';
import { isTicketType, TICKET_TYPES, type TicketType } from './ticketTypes.js';
import { slugifyTitleKey } from './titleKey.js';
import { nowIso } from '../model/time.js';
import { deleteGraphRunData, graphRunIdsForTicket } from './graph/graphRuns.js';

export interface Ticket {
  id: number;
  key: string | null;
  title: string | null;
  source: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  sessionId: string | null;
  /** v2 ticket-form fields (§ ticket form). */
  description: string | null;
  brief: string | null;
  sourceRef: string | null;
  sourceFetchedAt: string | null;
  approach: string | null;
  /** Chosen single-subagent id (§ single-subagent selection); nullable. */
  agent: string | null;
  /** Parsed from the `selected_repos` JSON column; `[]` when unset/invalid. */
  selectedRepos: string[];
  /** Parsed from the `base_refs` JSON column; `{}` when unset/invalid. */
  baseRefs: Record<string, string>;
  /** Soft-delete timestamp; `null` = active. Archived tickets hide by default. */
  archivedAt: string | null;
  /** Last mutation timestamp; bumped by every writer here. Surfaced so a ticket
   * picker can label a row by recency — listing order stays `created_at DESC`,
   * and the diagnostic report never reads it (it would be a bare wall clock). */
  updatedAt: string | null;
  /** Per-ticket launch model id (§ model selection); `null` = inherit the manifest default. */
  model: string | null;
  /**
   * Per-ticket effort/variant override (§ Execution policy resolution);
   * `null` = inherit the manifest default effort. Resolved against the live
   * catalog at launch like `model` is.
   */
  effort: string | null;
  /** Per-ticket agent-core override (§ agent core selection); `null` = inherit `manifest.agentProvider`. */
  agentProvider: AgentProvider | null;
  /** Per-ticket agent-preset override; `null` = inherit `manifest.defaultAgentPreset`. */
  agentPreset: string | null;
  /**
   * Agent core that minted `sessionId` (§5.3). A session id is private to the
   * CLI that created it, so this is what makes a resume provably safe; `null`
   * (legacy row, or a capture with no resolver) means "unknown — never resume".
   */
  sessionProvider: AgentProvider | null;
  /**
   * Conventional-commit type feeding the `{type}` token of the branch/commit/PR
   * templates; `null` = inherit `conventions.defaultType` (else `feat`).
   */
  type: TicketType | null;
  /**
   * Owning project (§ projects / multi-window); `null` for a ticket created
   * before v6, until the first window to bind adopts it.
   */
  projectId: number | null;
  /**
   * The completed ticket this one continues work from (§ continue work on a
   * ticket); `null` for an ordinary ticket. Set once, at creation.
   */
  parentTicketId: number | null;
  /**
   * The OPEN ticket this one is PART OF (a sub-task, design §3); `null` for an
   * ordinary top-level ticket. Deliberately distinct from `parentTicketId`,
   * which keeps meaning "follow-up of" — the two relations are orthogonal.
   * Set once, at creation; v1 has no re-parenting.
   */
  subtaskParentId: number | null;
  /**
   * Whether this sub-task blocks its parent from leaving `impl`/`fix` until it
   * is done (`blocks_parent = 1`). `false` for an ordinary ticket or a
   * non-blocking sub-task.
   */
  blocksParent: boolean;
  /**
   * Queued to auto-start implementation (`autostart_pending = 1`, v64). Set in
   * the creating INSERT; cleared only by the autostart op's atomic claim.
   */
  autostartPending: boolean;
  /**
   * Provider-native priority label (e.g. 'urgent', 'high', 'normal'), populated
   * from the ticketing provider when the ticket is fetched; `null` when the
   * provider did not expose one (a manual ticket, or an unfetched one).
   */
  priority: string | null;
  /** Task execution pause timestamp; `null` = active, non-null = execution paused. */
  pausedAt: string | null;
}

export interface TicketWithStages extends Ticket {
  stages: Stage[];
}

interface TicketRow {
  id: number;
  key: string | null;
  title: string | null;
  source: string | null;
  stage_current: string | null;
  agent_state: string | null;
  session_id: string | null;
  description: string | null;
  brief: string | null;
  source_ref: string | null;
  source_fetched_at: string | null;
  approach: string | null;
  agent: string | null;
  selected_repos: string | null;
  base_refs: string | null;
  archived_at: string | null;
  updated_at: string | null;
  model: string | null;
  agent_provider: string | null;
  agent_preset: string | null;
  session_provider: string | null;
  type: string | null;
  effort: string | null;
  project_id: number | null;
  parent_ticket_id: number | null;
  subtask_parent_id: number | null;
  blocks_parent: number | null;
  autostart_pending: number;
  priority: string | null;
  paused_at: string | null;
}

/**
 * Human label for a ticket in UI chrome (dashboard tab, spin picker title):
 * `"<key> — <title>"`, falling back to `#<id>` when key is unset and
 * `(untitled)` when title is unset. Single source of the convention the sidebar
 * (items.ts) also follows, so labels can't drift across surfaces.
 */
export function ticketLabel(ticket: Ticket, template?: string): string {
  return renderTicketLabel(ticket, template);
}

/** Parse the `selected_repos` JSON column into a string[], tolerating bad data. */
function parseSelectedRepos(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Parse the `base_refs` JSON column into a record, tolerating bad data. */
function parseBaseRefs(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function rowToTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    source: r.source,
    stageCurrent: r.stage_current,
    agentState: r.agent_state,
    sessionId: r.session_id,
    description: r.description,
    brief: r.brief,
    sourceRef: r.source_ref,
    sourceFetchedAt: r.source_fetched_at,
    approach: r.approach,
    agent: r.agent,
    selectedRepos: parseSelectedRepos(r.selected_repos),
    baseRefs: parseBaseRefs(r.base_refs),
    archivedAt: r.archived_at,
    updatedAt: r.updated_at,
    model: r.model,
    effort: r.effort,
    agentProvider: isKnownProvider(r.agent_provider) ? r.agent_provider : null,
    agentPreset: r.agent_preset,
    sessionProvider: isKnownProvider(r.session_provider) ? r.session_provider : null,
    // Narrow on read too: the column is plain TEXT, and a value that predates a
    // vocabulary change must degrade to "inherit the default", never render.
    type: isTicketType(r.type) ? r.type : null,
    projectId: r.project_id,
    parentTicketId: r.parent_ticket_id,
    subtaskParentId: r.subtask_parent_id ?? null,
    blocksParent: r.blocks_parent === 1,
    autostartPending: r.autostart_pending === 1,
    priority: r.priority,
    pausedAt: r.paused_at ?? null,
  };
}

/**
 * Create a ticket and seed one row per MVP stage as `pending` (no `fetch`, C1).
 * Runs in a transaction so a ticket never exists without its stage rows.
 * Seeds `stage_current='scope'` and `agent_state='none'` (manual create path).
 */
export function createTicket(
  store: Store,
  input: {
    key: string;
    title: string;
    source?: string;
    description?: string;
    /** Owning project; omitted only by legacy/test callers that predate scoping. */
    projectId?: number;
    /** Links a follow-up ticket to the completed parent it continues work from. */
    parentTicketId?: number;
    /** Links a sub-task to the open parent it is PART OF (design §3). */
    subtaskParentId?: number;
    /** Whether the sub-task blocks its parent from leaving `impl`/`fix`. */
    blocksParent?: boolean;
    /** Queue the ticket for auto-start (v64); written in the same INSERT. */
    autostartPending?: boolean;
  },
): Ticket {
  const create = store.db.transaction((): Ticket => {
    const info = store.db
      .prepare(
        `INSERT INTO tickets (key, title, source, description, project_id, parent_ticket_id, subtask_parent_id, blocks_parent, autostart_pending, stage_current, agent_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scope', 'none')`,
      )
      .run(
        input.key,
        input.title,
        input.source ?? 'manual',
        input.description ?? null,
        input.projectId ?? null,
        input.parentTicketId ?? null,
        input.subtaskParentId ?? null,
        input.blocksParent ? 1 : null,
        input.autostartPending ? 1 : 0,
      );
    const id = Number(info.lastInsertRowid);

    const seed = store.db.prepare(
      'INSERT INTO stages (ticket_id, stage_key, status, attempt) VALUES (?, ?, ?, 0)',
    );
    for (const key of STAGE_KEYS) seed.run(id, key, 'pending');

    return getBareTicket(store, id);
  });
  return create();
}

function getBareTicket(store: Store, id: number): Ticket {
  const row = store.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
    | TicketRow
    | undefined;
  if (!row) throw new Error(`ticket ${id} not found`);
  return rowToTicket(row);
}

/**
 * Restricts a query to one project (§ projects / multi-window). Omit
 * `projectId` for the unscoped, every-project view (an "All projects" facet, or
 * a caller that legitimately owns the whole DB, like crash recovery).
 */
export interface ProjectScope {
  projectId?: number;
}

/**
 * SQL fragment + bind params for a project scope. A ticket with no project
 * (pre-v6, not yet adopted) is deliberately excluded from every scoped query:
 * showing it in one window would be showing it in all of them, which is the
 * cross-project leak scoping exists to prevent.
 */
function scopeClause(scope: ProjectScope): { sql: string; params: number[] } {
  return scope.projectId === undefined
    ? { sql: '', params: [] }
    : { sql: 'project_id = ?', params: [scope.projectId] };
}

/** Join non-empty WHERE conditions into a clause (or '' when there are none). */
function whereClause(...conditions: string[]): string {
  const kept = conditions.filter((c) => c.length > 0);
  return kept.length ? `WHERE ${kept.join(' AND ')}` : '';
}

/**
 * Find a ticket by its numeric id, or `undefined` when none matches — the
 * total counterpart of `getTicket`, which throws. Scope by project the same way
 * `getTicketByKey` does, so an id from another project's board resolves to
 * nothing rather than to a stranger's ticket.
 */
export function findTicketById(
  store: Store,
  id: number,
  scope: ProjectScope = {},
): Ticket | undefined {
  const { sql, params } = scopeClause(scope);
  const row = store.db
    .prepare(`SELECT * FROM tickets ${whereClause('id = ?', sql)} LIMIT 1`)
    .get(id, ...params) as TicketRow | undefined;
  return row ? rowToTicket(row) : undefined;
}

/**
 * Find a ticket by its key, or `undefined` when none matches. Scope by project
 * whenever the caller has one: two projects may legitimately carry the same key
 * (both tracking `PROJ-1`), and an unscoped lookup would return whichever was
 * created first.
 *
 * When a key is nonetheless held by more than one row (a reused/re-created key,
 * or a legacy unadopted row plus a scoped one), the NON-ARCHIVED row wins — an
 * archived row is the stale namesake, and returning it silently hid the live
 * ticket from `karst context`. `getTicketsByKey` is the window into the full
 * collision; callers that must refuse true ambiguity (two live namesakes) build
 * on it rather than on this single-row convenience.
 */
export function getTicketByKey(
  store: Store,
  key: string,
  scope: ProjectScope = {},
): Ticket | undefined {
  return getTicketsByKey(store, key, scope)[0];
}

/**
 * Every ticket whose key matches, ordered active-first and then by id ascending.
 *
 * The order is the resolution policy in one place: a live ticket outranks an
 * archived namesake, and among equals the oldest row (lowest id) is the stable
 * tiebreak, so resolution never depends on SQLite's unspecified row order.
 */
export function getTicketsByKey(
  store: Store,
  key: string,
  scope: ProjectScope = {},
): Ticket[] {
  const { sql, params } = scopeClause(scope);
  const rows = store.db
    .prepare(
      `SELECT * FROM tickets ${whereClause('key = ?', sql)} ORDER BY (archived_at IS NOT NULL) ASC, id ASC`,
    )
    .all(key, ...params) as TicketRow[];
  return rows.map(rowToTicket);
}

/**
 * Auto-generated key for a manually created ticket left blank by the user
 * (§ manual ticket creation — key is optional).
 *
 * With a `seedTitle` the key is DERIVED from the title (`Fix login redirect` →
 * `FIX-LOGIN-REDIRECT`), suffixed `-2`, `-3`… when that name is already taken in
 * scope: the title is the only identity a manual ticket actually carries, and a
 * readable key is what shows on the board. Without one — or when the title has
 * nothing key-able in it — it falls back to `MANUAL-XXXXXXXX`, shaped like a
 * hand-typed key so downstream consumers can't tell it apart from one the user
 * supplied. Collisions are astronomically unlikely at 4 bytes of entropy, but a
 * retry-on-collision loop makes the uniqueness guarantee actual rather than
 * probabilistic, scoped the same way `getTicketByKey` is.
 */
export function generateTicketKey(
  store: Store,
  scope: ProjectScope = {},
  seedTitle?: string,
): string {
  const base = slugifyTitleKey(seedTitle ?? '');
  if (base) {
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!getTicketByKey(store, candidate, scope)) return candidate;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `MANUAL-${randomBytes(4).toString('hex').toUpperCase()}`;
    if (!getTicketByKey(store, candidate, scope)) return candidate;
  }
  throw new Error('failed to generate a unique ticket key');
}

/** Load a ticket with all its stage rows. Throws if the id is unknown. */
export function getTicket(store: Store, id: number): TicketWithStages {
  const ticket = getBareTicket(store, id);
  const stages = loadStages(store, id);
  return { ...ticket, stages };
}

function loadStages(store: Store, id: number): Stage[] {
  const stageRows = store.db
    .prepare('SELECT * FROM stages WHERE ticket_id = ?')
    .all(id);
  return stageRows.map((r) => rowToStage(r as Parameters<typeof rowToStage>[0]));
}

/**
 * Set a ticket's `agent_state` — the ONLY liveness signal, driven by hooks
 * (§5.4). Never touches stage state (the no-inference guarantee). Single-writer
 * discipline: all agent_state mutation goes through here.
 */
export function setAgentState(
  store: Store,
  ticketId: number,
  agentState: 'running' | 'waiting' | 'idle' | 'none',
): void {
  store.db
    .prepare('UPDATE tickets SET agent_state = ? WHERE id = ?')
    .run(agentState, ticketId);
}

/**
 * Move a ticket's `stage_current` pointer — the ONLY writer of that column.
 * Single-writer discipline (NDL-37): every caller that used to reach for a raw
 * `UPDATE tickets SET stage_current` goes through here instead, so a future
 * change to what moving a ticket means (validation, event emission, invariant
 * checks) cannot be silently bypassed by a call site that skipped this
 * function. Deliberately does not touch `stages` rows — pair this with
 * `setStage` calls the same way the raw writers it replaces did.
 */
export function setStageCurrent(store: Store, ticketId: number, stage: StageKey): void {
  store.db
    .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
    .run(stage, ticketId);
}

/**
 * Queue (true) or unqueue (false) a ticket for auto-start — the single writer
 * of `autostart_pending` after creation, apart from the atomic claim.
 */
export function setAutostartPending(store: Store, ticketId: number, pending: boolean): void {
  store.db
    .prepare("UPDATE tickets SET autostart_pending = ?, updated_at = datetime('now') WHERE id = ?")
    .run(pending ? 1 : 0, ticketId);
}

/**
 * Atomically claim a queued ticket for auto-start: clears `autostart_pending`
 * only if it is still set, so across windows and overlapping sweeps exactly one
 * caller sees `true` and proceeds to start the ticket.
 */
export function claimAutostart(store: Store, ticketId: number): boolean {
  const info = store.db
    .prepare(
      "UPDATE tickets SET autostart_pending = 0, updated_at = datetime('now') WHERE id = ? AND autostart_pending = 1",
    )
    .run(ticketId);
  return info.changes === 1;
}

/**
 * Set (or, with `null`, clear) a ticket's `session_id` — the agent session to
 * `--resume` (§5.3) — together with the agent core that minted it. Captured
 * from the SessionStart hook; cleared when a resume launch dies before starting
 * (the captured id no longer resolves — e.g. the agent's session store was
 * pruned or the worktree was recreated) so the next launch falls back to a
 * fresh, seeded session instead of repeating the same crash.
 *
 * The two columns are written by one statement because they are one fact: an id
 * without its provider is unusable (never resumed), and a provider without its
 * id means nothing. Single-writer discipline: all session_id AND session_provider
 * mutation goes through here.
 */
export function setSessionId(
  store: Store,
  ticketId: number,
  sessionId: string | null,
  sessionProvider: AgentProvider | null,
): void {
  store.db
    .prepare('UPDATE tickets SET session_id = ?, session_provider = ? WHERE id = ?')
    .run(sessionId, sessionProvider, ticketId);
}

/**
 * Update a ticket's core identity fields (key/title) — the Edit-mode MVP writer.
 * `updated_at` bumps so downstream reconcilers see the change. Single-writer
 * discipline: core mutation goes through here.
 */
export function updateTicketCore(
  store: Store,
  ticketId: number,
  patch: { key?: string; title?: string },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.key !== undefined) {
    sets.push('key = ?');
    vals.push(patch.key);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    vals.push(patch.title);
  }
  if (sets.length === 0) return; // empty patch: no-op
  sets.push("updated_at = datetime('now')");
  store.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ticketId);
}

/** The subset of ticket-form fields a patch can set (all optional). */
export interface TicketFieldsPatch {
  description?: string;
  brief?: string;
  sourceRef?: string;
  sourceFetchedAt?: string;
  approach?: string;
  agent?: string;
  selectedRepos?: string[];
  /** Per-repo base branch chosen before the ticket is spun; keyed by repo path/name. */
  baseRefs?: Record<string, string>;
  /** Per-ticket launch model id; empty string clears it back to inherit. */
  model?: string;
  /** Per-ticket effort/variant override; empty string clears it back to inherit. */
  effort?: string;
  /** Per-ticket agent-core override; empty string clears it back to inherit. */
  agentProvider?: string;
  /** Per-ticket agent-preset name; empty string clears it back to inherit. */
  agentPreset?: string;
  /**
   * Conventional-commit type; empty string clears it back to inherit. Validated
   * against `TICKET_TYPES` here — the value reaches branch names and PR titles,
   * and the analyzer that suggests it is an untrusted (model) source.
   */
  type?: string;
  /**
   * Provider-native priority label (e.g. 'urgent'); empty string clears it back
   * to NULL. Populated by the ticket form's fetch, never authored by the user.
   */
  priority?: string;
}

/**
 * Update a ticket's form fields (§ ticket form) — the persistence for the
 * ticket form's fetch/brief/repo/approach state. Only the supplied fields
 * are written; `selectedRepos` is stored as a JSON array. Single-writer.
 */
export function updateTicketFields(
  store: Store,
  ticketId: number,
  patch: TicketFieldsPatch,
): void {
  const columns: Record<string, unknown> = {};
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.brief !== undefined) columns.brief = patch.brief;
  if (patch.sourceRef !== undefined) columns.source_ref = patch.sourceRef;
  if (patch.sourceFetchedAt !== undefined) columns.source_fetched_at = patch.sourceFetchedAt;
  if (patch.approach !== undefined) columns.approach = patch.approach;
  if (patch.agent !== undefined) columns.agent = patch.agent;
  if (patch.selectedRepos !== undefined) {
    columns.selected_repos = JSON.stringify(patch.selectedRepos);
  }
  if (patch.baseRefs !== undefined) {
    columns.base_refs = JSON.stringify(patch.baseRefs);
  }
  // An explicit empty string clears the per-ticket model back to "inherit" (NULL).
  if (patch.model !== undefined) columns.model = patch.model === '' ? null : patch.model;
  // Same "inherit" convention for the per-ticket effort/variant override.
  if (patch.effort !== undefined) columns.effort = patch.effort === '' ? null : patch.effort;
  // Same "inherit" convention for the per-ticket agent-core override. A switch
  // deliberately does NOT touch session_id here: the session carries its own
  // `session_provider` tag, so a now-foreign session is simply not resumed
  // (resumeDecision.ts). That also covers the switch this function never sees —
  // a change to the manifest-level default, which re-points every inheriting
  // ticket at a different core without any ticket row being written.
  if (patch.agentProvider !== undefined) {
    columns.agent_provider = patch.agentProvider === '' ? null : patch.agentProvider;
  }
  if (patch.agentPreset !== undefined) {
    columns.agent_preset = patch.agentPreset === '' ? null : patch.agentPreset;
  }
  if (patch.type !== undefined) {
    if (patch.type !== '' && !isTicketType(patch.type)) {
      throw new Error(
        `unknown ticket type "${patch.type}" (expected one of: ${TICKET_TYPES.join(', ')})`,
      );
    }
    columns.type = patch.type === '' ? null : patch.type;
  }
  if (patch.priority !== undefined) {
    columns.priority = patch.priority === '' ? null : patch.priority;
  }

  const entries = Object.entries(columns);
  if (entries.length === 0) return; // empty patch: no-op
  const sets = entries.map(([col]) => `${col} = ?`);
  sets.push("updated_at = datetime('now')");
  store.db
    .prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), ticketId);
}

/**
 * A ticket that is the parent of one or more open (non-archived) sub-tasks
 * cannot be archived or hard-deleted (design §3, "Delete and archive"). The
 * sub-tasks are named so the caller can tell the user which ones to finish or
 * archive first. An archived sub-task does NOT gate its parent.
 */
export class TicketHasOpenSubtasksError extends Error {
  /** Keys of the open sub-tasks that blocked the operation, in id order. */
  readonly subtaskKeys: string[];
  constructor(ticketId: number, subtaskKeys: string[]) {
    super(
      `ticket #${ticketId} has open sub-tasks (${subtaskKeys.join(', ')}) — archive or delete them first`,
    );
    this.name = 'TicketHasOpenSubtasksError';
    this.subtaskKeys = subtaskKeys;
  }
}

/**
 * The open (non-archived) direct sub-tasks of `ticketId`, oldest first. Keys
 * fall back to `#<id>` at the call site so a message always names something
 * actionable.
 */
export function listOpenSubtasks(
  store: Store,
  ticketId: number,
): { id: number; key: string | null }[] {
  return store.db
    .prepare(
      'SELECT id, key FROM tickets WHERE subtask_parent_id = ? AND archived_at IS NULL ORDER BY id',
    )
    .all(ticketId) as { id: number; key: string | null }[];
}

/**
 * One direct sub-task, as the parent's `## Sub-tasks` context section reads it
 * (design NDL-70 §7): identity plus the two facts a parent needs — where the
 * delegated work stands and whether it holds the parent.
 */
export interface SubtaskListing {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  blocksParent: boolean;
  /** Queued to auto-start (`autostart_pending = 1`, v64). */
  autostartPending: boolean;
}

/**
 * The non-archived direct sub-tasks of `ticketId`, oldest first. Unlike
 * `listOpenSubtasks` this also carries title/stage/blocking so the parent's
 * context can list the delegated work without a row read per child. Archived
 * sub-tasks are omitted: abandoning one is the sanctioned way to unblock a
 * parent, so it is no longer work the parent is waiting on.
 */
export function listSubtasks(store: Store, ticketId: number): SubtaskListing[] {
  const rows = store.db
    .prepare(
      'SELECT id, key, title, stage_current, blocks_parent, autostart_pending FROM tickets WHERE subtask_parent_id = ? AND archived_at IS NULL ORDER BY id',
    )
    .all(ticketId) as {
    id: number;
    key: string | null;
    title: string | null;
    stage_current: string | null;
    blocks_parent: number | null;
    autostart_pending: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    stageCurrent: r.stage_current,
    blocksParent: r.blocks_parent === 1,
    autostartPending: r.autostart_pending === 1,
  }));
}

/** Throw when `ticketId` is the parent of any non-archived sub-task. */
export function assertNoOpenSubtasks(store: Store, ticketId: number): void {
  const open = listOpenSubtasks(store, ticketId);
  if (open.length > 0) {
    throw new TicketHasOpenSubtasksError(
      ticketId,
      open.map((t) => t.key ?? `#${t.id}`),
    );
  }
}

/**
 * Clear a sub-task's parent link — the detach write (design NDL-70 §5). Guarded
 * by the parent it was expected to still have (`subtask_parent_id = ?`), so a
 * concurrent re-parent/clear cannot be clobbered; returns whether a row matched.
 *
 * `blocks_parent` is zeroed in the SAME statement: the leave-impl gate only
 * exists for a sub-task, so a detached top-level ticket must not carry the flag.
 * A single statement keeps the two facts from ever disagreeing. The autostart
 * queue flag is cleared the same way: a detached ticket is no longer a sub-task
 * the parent's sweep may start.
 */
export function detachSubtaskParent(
  store: Store,
  ticketId: number,
  expectedParentId: number,
): boolean {
  const info = store.db
    .prepare(
      'UPDATE tickets SET subtask_parent_id = NULL, blocks_parent = 0, autostart_pending = 0 WHERE id = ? AND subtask_parent_id = ?',
    )
    .run(ticketId, expectedParentId);
  return info.changes > 0;
}

/**
 * Clear `approach` from every ticket bound to `approachId`, returning how many
 * rows were cleared.
 *
 * This is the ticket half of an approach uninstall (869eckp0x). Removing the
 * package directory leaves `tickets.approach` pointing at something that no
 * longer exists, and the launcher reports that dangling reference on every
 * session open ("produced no method prompt or loadable artifacts") — forever,
 * because the ticket-form picker DROPS sourced-but-uninstalled approaches, so
 * the stale value is not even offered as an option the user could change. The
 * reference belongs to the approach, not to the ticket, so the uninstall that
 * removed the approach is what clears it.
 *
 * Scoped by project like every other ticket query: the DB is shared by every
 * IDE window, and an uninstall in this workspace must never rewrite another
 * project's tickets. Archived tickets ARE included — a dangling reference is
 * just as dangling after an unarchive.
 */
export function clearApproachFromTickets(
  store: Store,
  approachId: string,
  scope: ProjectScope = {},
): number {
  const { sql, params } = scopeClause(scope);
  const where = whereClause('approach = ?', sql);
  const info = store.db
    .prepare(`UPDATE tickets SET approach = NULL, updated_at = datetime('now') ${where}`)
    .run(approachId, ...params);
  return Number(info.changes);
}

/**
 * Archive a ticket (soft-delete): stamp `archived_at` now. Idempotent-ish — an
 * already-archived ticket gets a fresh timestamp. Single-writer discipline.
 *
 * Refused when the ticket is the parent of any non-archived sub-task (design
 * §3): a parent whose work is still carved out cannot itself disappear. An
 * archived sub-task does not gate its parent, so abandoning a sub-task is a
 * legitimate way to unblock the parent.
 */
export function archiveTicket(store: Store, ticketId: number): void {
  assertNoOpenSubtasks(store, ticketId);
  store.db
    // Unqueued in the same write: archived work must never auto-start.
    .prepare("UPDATE tickets SET archived_at = datetime('now'), autostart_pending = 0, updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
}

/**
 * Unarchive a ticket: clear `archived_at` and reset `created_at` so it sorts to top.
 *
 * A ticket unarchived while still at `done` also gets its done stage's
 * `ended_at` re-stamped to now: that timestamp IS the auto-archive clock
 * (store/doneArchive.ts), so without the reset the next sweep tick would
 * re-archive the ticket the user just brought back — "unarchived" would last
 * a minute instead of a full delay (869eck7my).
 */
export function unarchiveTicket(store: Store, ticketId: number): void {
  store.db
    .prepare("UPDATE tickets SET archived_at = NULL, created_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
  const ticket = getBareTicket(store, ticketId);
  if (ticket.stageCurrent === 'done') {
    setStage(store, ticketId, 'done', { endedAt: nowIso() });
  }
}

/**
 * Pause task execution: stamp `paused_at` now so driver, auto-heal, graph runs,
 * and automated session launches skip this ticket. Single-writer discipline.
 */
export function pauseTicket(store: Store, ticketId: number): void {
  store.db
    .prepare("UPDATE tickets SET paused_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
}

/**
 * Resume task execution (unpause): clear `paused_at`. Single-writer discipline.
 */
export function unpauseTicket(store: Store, ticketId: number): void {
  store.db
    .prepare("UPDATE tickets SET paused_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
}

/** Related tables keyed by `ticket_id`, cleared on hard-delete (no FK cascade).
 *
 * The four append-only/current-state evidence tables (`gate_runs`, `stage_runs`,
 * `phase_marks`, `merge_checks`) declare no FK to `tickets` — a hard delete used
 * to leave their rows answering queries by a ticket id nothing owns. They are
 * ticket-owned evidence and die with the ticket (archive keeps them), so they
 * belong HERE, not as a cascade: the explicit leaf-first delete is the product
 * deletion contract, never SQLite's discovery. */
const TICKET_CHILD_TABLES = [
  'stages',
  // Leaf before its parent: `gate_runs.stage_run_id` references `stage_runs`
  // (ON DELETE SET NULL), so the rows that name a run go first.
  'gate_runs',
  'stage_runs',
  'phase_marks',
  'merge_checks',
  'worktrees',
  'worktree_archives',
  'port_allocations',
  'baseline_refs',
  'servers',
  'prs',
  'pr_feedback',
  'ticket_attachments',
  'test_logs',
  'test_hooks',
] as const;

/**
 * Hard-delete a ticket and all its child rows in a transaction. There are no FK
 * cascades on the child tables (except `process_runs`, which cascades off
 * `tickets`), so each is cleared explicitly. Irreversible — the caller (UI)
 * confirms first.
 *
 * The ORDER is the product deletion contract (v27), not SQLite's discovery: the
 * global accounting ledger is detached FIRST so its rows survive the delete,
 * then every execution-attribution column is cleared so evidence rows can be
 * removed leaf-first, THEN ticket-owned evidence (findings, then the process
 * runs that are the roots of the `ON DELETE SET NULL` references) goes, then
 * the graph evidence subtree leaf-first (Slice 2 Task 8: tokens, overrides,
 * leases, workspaces, artifact instances, node runs, planner runs, revisions,
 * graph runs — no `ON DELETE CASCADE` fires on any of the nine, correctness
 * never depends on a cascade), and only finally the older child tables and the
 * ticket row itself. With foreign keys ON, any other order can surface a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` — or, worse, silently delete spend that
 * belongs to the ledger, not the ticket.
 *
 * When `graphBytesRoot` (the `<globalStorage>/graph/<projectSlug>` directory)
 * is provided, the ticket's graph byte subtree is removed AFTER the rows
 * commit — the retention sweep covers the case where it is absent. Likewise
 * `artifactsRoot` (the `<globalStorage>/artifacts` directory) removes the
 * ticket's gate console-log dir, with the same sweep covering the absent case.
 * Archive removes nothing (see archiveTicket).
 */
export function deleteTicket(
  store: Store,
  ticketId: number,
  graphBytesRoot?: string,
  artifactsRoot?: string,
): void {
  assertNoOpenSubtasks(store, ticketId);
  const del = store.db.transaction((): void => {
    // 1. Detach the global accounting ledger. `token_usage` is shared global
    // spend, not ticket-owned evidence: its rows survive the ticket as
    // unattributed counts, exactly like the rows recorded before the ticket
    // existed. `review_findings` has no `ticket_id` detachment — a finding is
    // ticket-owned evidence and dies with the ticket.
    store.db
      .prepare('UPDATE token_usage SET ticket_id = NULL WHERE ticket_id = ?')
      .run(ticketId);
    // 2. Clear every execution-attribution column present in the final schema,
    // so the deletions below never fire an FK action against a row about to be
    // deleted for another reason. token_usage rows were just detached, so they
    // are found through the ticket's own process runs — the same rows this
    // step clears attribution on.
    store.db
      .prepare(
        `UPDATE token_usage SET process_run_id = NULL
          WHERE process_run_id IN (SELECT id FROM process_runs WHERE ticket_id = ?)`,
      )
      .run(ticketId);
    store.db
      .prepare('UPDATE review_findings SET process_run_id = NULL WHERE ticket_id = ?')
      .run(ticketId);
    // 3. Delete ticket-owned evidence leaf-first: findings first, then the
    // process runs they (and the usage rows) referenced — the roots of the
    // v27 `ON DELETE SET NULL` columns. Both are deleted explicitly rather
    // than left to `ON DELETE CASCADE` from `tickets`, because evidence
    // cleanup is the ticket's contract, not SQLite's discovery.
    store.db.prepare('DELETE FROM review_findings WHERE ticket_id = ?').run(ticketId);
    store.db.prepare('DELETE FROM process_runs WHERE ticket_id = ?').run(ticketId);
    // 4. Graph evidence, leaf-first per graph run (Slice 2 Task 8). No
    // `ON DELETE CASCADE` is added to any graph table's ticket reference;
    // correctness never depends on a cascade firing. token_usage rows already
    // detached keep their spend and get their graph FKs SET NULL here. The
    // cascade lives in the graph store (NDL-38), not here.
    for (const graphRunId of graphRunIdsForTicket(store.db, ticketId)) {
      deleteGraphRunData(store.db, graphRunId);
    }
    // Mailbox rows name the ticket on either side; deleted explicitly (the
    // v64 FKs also cascade, but correctness never depends on a cascade).
    store.db
      .prepare('DELETE FROM ticket_messages WHERE to_ticket_id = ? OR from_ticket_id = ?')
      .run(ticketId, ticketId);
    for (const table of TICKET_CHILD_TABLES) {
      store.db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(ticketId);
    }
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
  });
  del();
  if (graphBytesRoot !== undefined) {
    rmSync(join(graphBytesRoot, String(ticketId)), { recursive: true, force: true });
  }
  if (artifactsRoot !== undefined) {
    rmSync(join(artifactsRoot, String(ticketId)), { recursive: true, force: true });
  }
}

/**
 * List tickets with their stage rows, ordered by created_at descending (most recent first),
 * with id descending as tiebreaker. Archived tickets are excluded by default;
 * pass `{ includeArchived: true }` to include them (the Archived facet / "show archived" path).
 */
export function listTickets(
  store: Store,
  opts: { includeArchived?: boolean } & ProjectScope = {},
): TicketWithStages[] {
  const { sql, params } = scopeClause(opts);
  const where = whereClause(opts.includeArchived ? '' : 'archived_at IS NULL', sql);
  const rows = store.db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, id DESC`)
    .all(...params) as TicketRow[];
  return rows.map((r) => {
    const ticket = rowToTicket(r);
    return { ...ticket, stages: loadStages(store, ticket.id) };
  });
}

/** List only archived tickets (the Archived facet view), ordered by created_at descending with id desc tiebreaker. */
export function listArchivedTickets(
  store: Store,
  scope: ProjectScope = {},
): TicketWithStages[] {
  const { sql, params } = scopeClause(scope);
  const where = whereClause('archived_at IS NOT NULL', sql);
  const rows = store.db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC, id DESC`)
    .all(...params) as TicketRow[];
  return rows.map((r) => ({ ...rowToTicket(r), stages: loadStages(store, r.id) }));
}
