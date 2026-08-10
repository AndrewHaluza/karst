import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalPath } from '../runtime/pathScope.js';

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
 * (`SessionStart` / `permission.asked` / `UserPromptSubmit`).
 */

/** Relative path of the per-conversation DBs under the app-data dir. */
export const AGY_CONVERSATIONS_RELATIVE = join('conversations');

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
  close(): void;
}

export type OpenAgyDb = (dbPath: string) => AgyConversationDb;

export function openAgyConversationDb(dbPath: string): AgyConversationDb {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const blobStmt = db.prepare(
    "SELECT data AS data FROM trajectory_metadata_blob WHERE id = 'main'",
  );
  const pendingStmt = db.prepare('SELECT COUNT(*) AS n FROM steps WHERE status = 9');
  return {
    workspaceBlob(): Buffer | null {
      const row = blobStmt.get() as { data: Buffer | null } | undefined;
      return row?.data ?? null;
    },
    pendingApprovalCount(): number {
      const row = pendingStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
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
}

/** Per-ticket memory of the last observed conversation state. */
export interface AgyWatchState {
  dbPath: string | null;
  started: boolean;
  awaiting: boolean;
}

export type AgyWatchEvent =
  | { kind: 'SessionStart'; sessionId: string }
  | { kind: 'permission.asked' }
  | { kind: 'UserPromptSubmit' };

/**
 * Diff one sweep tick against the last for ONE ticket. Emits only
 * transitions: a session start (once per conversation), the ask becoming
 * pending, and the ask resolving. `null` snapshot (no conversation yet) is
 * silent — the session may not have started, and its end is the terminal's
 * close, not a watcher concern.
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
    events.push({ kind: 'SessionStart', sessionId: snapshot.conversationId });
  }
  if (snapshot.pendingApproval && !state.awaiting) {
    state.awaiting = true;
    events.push({ kind: 'permission.asked' });
  } else if (!snapshot.pendingApproval && state.awaiting) {
    state.awaiting = false;
    events.push({ kind: 'UserPromptSubmit' });
  }
  return events;
}
