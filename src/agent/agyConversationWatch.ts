import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalPath } from '../runtime/pathScope.js';
import { aggregateConversationUsage, type AgyConversationUsage } from './agyUsageWatch.js';

/**
 * The Antigravity CLI's conversation state, read as a lifecycle channel.
 *
 * agy 1.1.11 loads `hooks.json` but never EXECUTES hooks in the CLI
 * conversation path (verified empirically — see docs/guides/adding-agent-core.md
 * § Antigravity), so a push bridge would be a silent fake signal. The real,
 * observable channel is the per-conversation SQLite DB the CLI writes at
 * `<appdata>/conversations/<conv-id>.db`: while the user is being asked to
 * approve a tool, the conversation has a `steps` row with `status = 9`
 * (pending user decision), which becomes `status = 3` when the user answers.
 * The same DB's `trajectory_metadata_blob` (row `id='main'`) carries the
 * workspace path as `file://<path>` bytes, which is how a ticket's worktree
 * finds its conversation.
 *
 * This module is vscode-free and host-agnostic: the extension sweep feeds it
 * per-ticket snapshots and it diffs them into the closed hook vocabulary
 * (`SessionStart` / `permission.asked` / `UserPromptSubmit` / `idle`). The
 * idle/turn-end edge is derived from the CLI's summary DB
 * (`conversation_summaries.db`), which carries a per-conversation run status —
 * the per-conversation DB cannot say whether the agent is mid-turn.
 */

/** Relative path of the per-conversation DBs under the app-data dir. */
export const AGY_CONVERSATIONS_RELATIVE = join('conversations');

/**
 * The CLI's cross-conversation summary DB (beside the `conversations/` dir).
 * Unlike the per-conversation DBs, it carries a per-conversation RUN STATUS —
 * `CASCADE_RUN_STATUS_IDLE` once a turn has ended and the agent is at its
 * prompt, a running value while it is mid-turn. That status is the idle/turn
 * signal the typed-nudge route waits for.
 */
export const AGY_SUMMARIES_DB = 'conversation_summaries.db';

/** The summary `status` value that means the conversation finished its turn. */
export const AGY_IDLE_STATUS = 'CASCADE_RUN_STATUS_IDLE';

/** Read handle on the CLI's summary DB (foreign schema — strictly read-only). */
export interface AgySummariesDb {
  /** True when the conversation's run status is idle; null when it has no row. */
  isIdle(conversationId: string): boolean | null;
  close(): void;
}

export type OpenAgySummariesDb = (dbPath: string) => AgySummariesDb;

export function openAgySummariesDb(dbPath: string): AgySummariesDb {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const stmt = db.prepare('SELECT status FROM conversation_summaries WHERE conversation_id = ?');
  return {
    isIdle(conversationId: string): boolean | null {
      const row = stmt.get(conversationId) as { status: string | null } | undefined;
      return row === undefined ? null : row.status === AGY_IDLE_STATUS;
    },
    close(): void {
      db.close();
    },
  };
}

/**
 * Whether the conversation is idle, read from the CLI's summary DB. Returns
 * `null` when the status is UNKNOWN — the DB or the conversation's row is
 * missing, or the read failed. `null` never throws and never holds mail: the
 * caller treats unknown as NOT busy (a summary the CLI has not written must not
 * strand a pointer forever), and isolates the read so a summary failure cannot
 * drop the lifecycle tick.
 */
export function readAgyConversationIdle(
  appDataDir: string,
  conversationId: string,
  openDb: OpenAgySummariesDb = openAgySummariesDb,
): boolean | null {
  const dbPath = join(appDataDir, AGY_SUMMARIES_DB);
  if (!existsSync(dbPath)) return null;
  let db: AgySummariesDb;
  try {
    db = openDb(dbPath);
  } catch {
    return null;
  }
  try {
    return db.isIdle(conversationId);
  } catch {
    // A locked/unreadable summary is UNKNOWN, never a reason to drop the tick.
    return null;
  } finally {
    db.close();
  }
}

/** agy's app-data dir: `ANTIGRAVITY_EXECUTABLE_DATA_DIR` if set, else `~/.gemini/antigravity-cli`. */
export function resolveAgyAppDataDir(
  env?: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  return typeof override === 'string' && override.length > 0
    ? override
    : join(home, '.gemini', 'antigravity-cli');
}

/** Read handle on one conversation DB (foreign schema — strictly read-only). */
export interface AgyConversationDb {
  /** Raw bytes of the `trajectory_metadata_blob` row `id='main'`, or null. */
  workspaceBlob(): Buffer | null;
  /** How many `steps` rows are awaiting a user decision (`status = 9`). */
  pendingApprovalCount(): number;
  /** Cumulative per-call usage recorded in this conversation, or null when none yet. */
  usage(): AgyConversationUsage | null;
  close(): void;
}

export type OpenAgyDb = (dbPath: string) => AgyConversationDb;

export function openAgyConversationDb(dbPath: string): AgyConversationDb {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const blobStmt = db.prepare(
    "SELECT data AS data FROM trajectory_metadata_blob WHERE id = 'main'",
  );
  const pendingStmt = db.prepare('SELECT COUNT(*) AS n FROM steps WHERE status = 9');
  const usageStmt = db.prepare('SELECT idx, metadata FROM steps ORDER BY idx');
  return {
    workspaceBlob(): Buffer | null {
      const row = blobStmt.get() as { data: Buffer | null } | undefined;
      return row?.data ?? null;
    },
    pendingApprovalCount(): number {
      const row = pendingStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    usage(): AgyConversationUsage | null {
      const rows = usageStmt.all() as { idx: number; metadata: Buffer | null }[];
      return aggregateConversationUsage(rows);
    },
    close(): void {
      db.close();
    },
  };
}

const FILE_URI_PREFIX = 'file://';

function blobNamesWorktree(blob: Buffer, worktreePath: string): boolean {
  const candidates = [worktreePath, canonicalPath(worktreePath)];
  for (const candidate of candidates) {
    if (candidate && blob.includes(Buffer.from(FILE_URI_PREFIX + candidate))) return true;
  }
  return false;
}

function conversationIdOf(dbPath: string): string {
  return basename(dbPath, extname(dbPath));
}

/**
 * Locate the conversation DB whose workspace blob names `worktreePath`. When
 * several conversations share a worktree (a session ended and a new one began),
 * the NEWEST db file wins — a live session writes its DB continuously, so its
 * file is the freshest. Returns null when nothing matches. Pure over the
 * injected seams; `openDb`/`listDbs` default to the real filesystem.
 */
export function findConversationForWorktree(
  appDataDir: string,
  worktreePath: string,
  openDb: OpenAgyDb = openAgyConversationDb,
  listDbs: (dir: string) => string[] = (dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => join(dir, name));
  },
): { dbPath: string; conversationId: string } | null {
  let best: { dbPath: string; conversationId: string; mtimeMs: number } | null = null;
  for (const dbPath of listDbs(join(appDataDir, AGY_CONVERSATIONS_RELATIVE))) {
    let db: AgyConversationDb;
    try {
      db = openDb(dbPath);
    } catch {
      continue; // a conversation being created concurrently must not fail the tick
    }
    try {
      const blob = db.workspaceBlob();
      if (blob === null || !blobNamesWorktree(blob, worktreePath)) continue;
      const mtimeMs = (() => {
        try {
          return statSync(dbPath).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (best === null || mtimeMs > best.mtimeMs) {
        best = { dbPath, conversationId: conversationIdOf(dbPath), mtimeMs };
      }
    } finally {
      db.close();
    }
  }
  return best === null ? null : { dbPath: best.dbPath, conversationId: best.conversationId };
}

/** One observed conversation state, diffed against `AgyWatchState`. */
export interface AgyConversationSnapshot {
  dbPath: string;
  conversationId: string;
  /** True while a `status = 9` step exists — the user's answer is pending. */
  pendingApproval: boolean;
  /**
   * The conversation's run status: `true` idle (a turn just ended and the agent
   * is at its prompt), `false` running, `null` unknown (the summary DB or row
   * is missing, or the read failed). Derived from the CLI's summary DB. The
   * typed-nudge route defers only on an explicit `false` — `null` must not hold
   * mail forever.
   */
  idle: boolean | null;
}

/** Per-ticket memory of the last observed conversation state. */
export interface AgyWatchState {
  dbPath: string | null;
  started: boolean;
  awaiting: boolean;
  /**
   * Last observed run status (`true` idle / `false` running / `null` unknown).
   * Drives the `idle` transition edge and the typed-nudge gate.
   */
  idle: boolean | null;
}

/**
 * Does the typed-pointer gate hold for a recipient? The gate exists only for
 * agy: every other core accepts a typed line at any time. An agy session gates
 * while its conversation has NOT been observed yet — a fresh session (or a
 * fresh activation map) has no state until the sweep's first tick, up to
 * `AGY_WATCH_INTERVAL_MS` away — and while its run status is an explicit
 * RUNNING. An observed-but-UNKNOWN status (`idle: null`) does NOT gate: a
 * summary the CLI never wrote must never strand mail.
 */
export function agyPointerBusy(
  state: AgyWatchState | undefined,
  isAgyRecipient: boolean,
): boolean {
  if (!isAgyRecipient) return false;
  return state === undefined || state.idle === false;
}

export type AgyWatchEvent =
  | { kind: 'SessionStart'; sessionId: string }
  | { kind: 'permission.asked' }
  | { kind: 'UserPromptSubmit' }
  /** The turn ended and the agent is back at its prompt (a running→idle edge). */
  | { kind: 'idle' };

/**
 * Diff one sweep tick against the last for ONE ticket. Emits only
 * transitions: a session start (once per conversation), the ask becoming
 * pending, the ask resolving, and the turn ending (running→idle). `null`
 * snapshot (no conversation yet) is silent — the session may not have started,
 * and its end is the terminal's close, not a watcher concern.
 *
 * The FIRST observation baselines `idle` from the snapshot without emitting a
 * transition: a freshly launched session that is briefly idle must not read as
 * a turn that just ended. The `idle` event fires only on a DEFINITE
 * running→idle edge; an unknown status (`null`) is tracked verbatim and never
 * emitted, so it cannot claim a turn ended.
 */
export function agyWatchTick(
  state: AgyWatchState,
  snapshot: AgyConversationSnapshot | null,
): AgyWatchEvent[] {
  if (snapshot === null) return [];
  const events: AgyWatchEvent[] = [];
  const sameConversation = state.dbPath === snapshot.dbPath;
  if (!sameConversation || !state.started) {
    state.dbPath = snapshot.dbPath;
    state.started = true;
    state.awaiting = false;
    state.idle = snapshot.idle;
    events.push({ kind: 'SessionStart', sessionId: snapshot.conversationId });
  }
  if (snapshot.pendingApproval && !state.awaiting) {
    state.awaiting = true;
    events.push({ kind: 'permission.asked' });
  } else if (!snapshot.pendingApproval && state.awaiting) {
    state.awaiting = false;
    events.push({ kind: 'UserPromptSubmit' });
  }
  if (snapshot.idle === true && state.idle === false) {
    events.push({ kind: 'idle' });
  }
  // Track the latest status verbatim: `false` (running) gates the typed route,
  // `true` is idle, and `null` (unknown) does NOT gate — an unreadable summary
  // must never hold mail. An idle event fires only on a definite running→idle
  // edge, so an unknown→idle observation can never fake a turn-end.
  state.idle = snapshot.idle;
  return events;
}
