import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { codexHome } from '../../agent/quota/codex.js';
import { sessionReaderEnv } from '../../agent/accounts/registry.js';
import type { Store } from '../../store/db.js';
import { getPlacement } from '../../store/placement.js';
import { getTicket } from '../../store/tickets.js';

/** How often the Codex rollout watch re-sweeps live terminals. */
export const CODEX_ROLLOUT_WATCH_INTERVAL_MS = 10_000;

/**
 * How much of a rollout's tail to read. The last turn event sits at the end; a
 * tens-of-MB session file must never be read whole (the read runs on the
 * extension host's event loop).
 */
export const CODEX_ROLLOUT_TAIL_BYTES = 512 * 1024;

/** A session id becomes part of a path only when it is a strict UUID. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of `TerminalIdentity` the sweep needs to route a session. */
export interface CodexTerminalNamed {
  readonly ticketId: number;
  readonly identity?: { readonly provider?: string };
}

/** Per-session memory: the located rollout and the fingerprint of the last successful read. */
interface RolloutState {
  path: string | null;
  fingerprint: { mtimeMs: number; size: number } | null;
}

export interface CodexRolloutWatchLoopDeps {
  readonly store: Store;
  /** The terminals currently open in the window. */
  readonly listTerminals: () => Iterable<unknown>;
  /** Resolve a terminal to its ticket identity, or `undefined` if unnamed. */
  readonly identifyTerminal: (terminal: unknown) => CodexTerminalNamed | undefined;
  /**
   * The rollout text of the ticket's Codex session. Called on every READ (a
   * changed file), never for an unchanged one; the once-per-error rule is the
   * binding's.
   */
  readonly onRollout: (ticketId: number, sessionId: string, text: string) => void;
  readonly debug: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
}

export interface CodexRolloutWatchLoop {
  /** Run one sweep now. Re-entrancy-safe: a call while one is in flight is a no-op. */
  run(): Promise<void>;
}

/**
 * One directory's entries, greatest name first. A rollout's name embeds the
 * session start time and a day directory is `YYYY`/`MM`/`DD`, so the greatest
 * name is the newest: the sweep visits the newest day first and, within one
 * day, offers the newest rollout.
 */
export function newestFirst<T extends { readonly name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Find `rollout-<time>-<sessionId>.jsonl` under `<home>/sessions/YYYY/MM/DD`.
 * Day directories are walked newest first ({@link newestFirst}), so the newest
 * file wins; a miss is normal (the session has not written a rollout yet). The
 * entry is returned by name only — symlinks and squatting directories are
 * refused by the read, which resolves and opens it safely.
 */
async function findRolloutFile(base: string, sessionId: string, depth = 3): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of newestFirst(entries)) {
    const full = join(base, entry.name);
    if (entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) return full;
    if (entry.isDirectory() && depth > 0) {
      const found = await findRolloutFile(full, sessionId, depth - 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Read the last {@link CODEX_ROLLOUT_TAIL_BYTES} of a rollout as text, dropping
 * the first (cut) line. The safe-read rules of the hook bridge's
 * `rolloutUsagePayload`: the real path must stay inside the real session root,
 * the file is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and only a regular
 * file is read. A refusal or an I/O fault throws; the caller logs and retries
 * next sweep.
 */
async function readRolloutTail(file: string, realRoot: string): Promise<string> {
  const real = await realpath(file);
  if (!real.startsWith(realRoot + sep)) throw new Error(`rollout ${real} is outside ${realRoot}`);
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`rollout ${real} is not a regular file`);
    const start = Math.max(0, st.size - CODEX_ROLLOUT_TAIL_BYTES);
    const length = st.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Codex interactive usage watch (`@arch:AC-42`). The Codex hook bridge forwards
 * no provider-error event, but the CLI records every turn in its own session
 * rollout, `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<session-id>.jsonl`:
 * a usage-limited turn is an `event_msg` `task_complete` whose `error` carries
 * `codex_error_info: 'usage_limit_exceeded'`. The sweep reads the tail of the
 * ticket session's rollout — host placements only, because a sandboxed session
 * writes its rollout inside the container — and hands the text to the binding,
 * whose `codexTrailingQuota` decides the last turn event and whose once-key
 * offers a single park. No prose, no other error code, and no newer turn ever
 * parks. Graph node/planner sessions are out of scope: their rollout location
 * is unverified.
 */
export function createCodexRolloutWatchLoop(deps: CodexRolloutWatchLoopDeps): CodexRolloutWatchLoop {
  const states = new Map<string, RolloutState>();
  let running = false;

  const sweepTicket = async (ticketId: number): Promise<void> => {
    const sessionId = getTicket(deps.store, ticketId).sessionId;
    if (!sessionId) {
      deps.debug(`[codex] ticket ${ticketId}: no sessionId`);
      return;
    }
    const placement = getPlacement(deps.store, ticketId);
    if (placement !== null && placement.backend !== 'host') {
      deps.debug(`[codex] ticket ${ticketId}: ${placement.backend} placement — the rollout watch reads host sessions only`);
      return;
    }
    if (!SESSION_ID_RE.test(sessionId)) {
      deps.debug(`[codex] ticket ${ticketId}: session id is not a UUID`);
      return;
    }
    const sessionsRoot = join(codexHome(sessionReaderEnv('codex', sessionId)), 'sessions');
    let realRoot: string;
    try {
      realRoot = await realpath(sessionsRoot);
    } catch (error) {
      deps.debug(`[codex] ticket ${ticketId}: no session root ${sessionsRoot} (${(error as NodeJS.ErrnoException).code})`);
      return;
    }
    const state = states.get(sessionId) ?? { path: null, fingerprint: null };
    let rolloutPath = state.path;
    if (rolloutPath === null) {
      const found = await findRolloutFile(sessionsRoot, sessionId);
      if (found === null) {
        deps.debug(`[codex] ticket ${ticketId}: no rollout yet for ${sessionId}`);
        return;
      }
      rolloutPath = found;
      state.path = found;
      states.set(sessionId, state);
    }
    let fingerprint: { mtimeMs: number; size: number };
    try {
      const st = await stat(rolloutPath);
      fingerprint = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (error) {
      // The cached file vanished (a new day directory, or an archived session):
      // forget it and look again next sweep.
      state.path = null;
      state.fingerprint = null;
      deps.debug(`[codex] ticket ${ticketId}: rollout missing: ${rolloutPath} (${(error as NodeJS.ErrnoException).code})`);
      return;
    }
    if (
      state.fingerprint !== null &&
      state.fingerprint.mtimeMs === fingerprint.mtimeMs &&
      state.fingerprint.size === fingerprint.size
    ) {
      return;
    }
    let text: string;
    try {
      text = await readRolloutTail(rolloutPath, realRoot);
    } catch (error) {
      deps.logError(`karst: codex rollout read failed for ticket ${ticketId}`, error);
      return;
    }
    // Recorded only after a successful read, so a failed read is retried.
    state.fingerprint = fingerprint;
    deps.onRollout(ticketId, sessionId, text);
  };

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const terminals = [...deps.listTerminals()];
      deps.debug(`[codex] sweep tick: ${terminals.length} terminals`);
      for (const terminal of terminals) {
        const named = deps.identifyTerminal(terminal);
        if (named?.identity?.provider !== 'codex') continue;
        try {
          await sweepTicket(named.ticketId);
        } catch (error) {
          deps.logError(`karst: codex rollout watch failed for ticket ${named.ticketId}`, error);
        }
      }
    } catch (error) {
      deps.logError('karst: codex rollout watch failed', error);
    } finally {
      running = false;
    }
  };

  return { run };
}
