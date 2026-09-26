import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { openStore, type Store } from '../../store/db.js';
import { createHookChannelRecorder } from '../../diagnostics/hookChannel.js';
import { createAgyWatchLoop, type AgyTerminalNamed, type AgyWatchLoopDeps } from './agyWatchLoop.js';
import type { AgyWatchState } from '../../agent/agyConversationWatch.js';
import type { AgyUsageState } from '../../agent/agyUsageWatch.js';

/**
 * `resolveAgyAppDataDir()` — called with no args by the loop, exactly as the
 * pre-extraction inline code called it — never reads `ANTIGRAVITY_EXECUTABLE_DATA_DIR`
 * (that requires an explicit `env` argument neither call site passes); it
 * resolves to `homedir()/.gemini/antigravity-cli`. `homedir()` itself reads
 * `$HOME`, so redirecting `$HOME` is how these tests aim the sweep at a
 * fixture tree without changing the loop's (preserved) behavior.
 */
function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** Builds a fixture agy conversation DB, matching the real CLI's schema. */
function fixtureDb(dir: string, name: string, workspacePath: string, pending: boolean): string {
  const conversationsDir = join(dir, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  const dbPath = join(conversationsDir, `${name}.db`);
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);' +
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, metadata BLOB);',
  );
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
    'main',
    Buffer.concat([Buffer.from([1]), Buffer.from(`file://${workspacePath}`), Buffer.from([2])]),
  );
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)').run();
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 5, ?)').run(pending ? 9 : 3);
  db.close();
  return dbPath;
}

function seedWorktree(store: Store, ticketId: number, path: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path) VALUES (?, ?, ?)')
    .run(ticketId, 'app', path);
}

function baseDeps(store: Store, overrides: Record<string, unknown> = {}) {
  const deps: AgyWatchLoopDeps = {
    store,
    listTerminals: () => [],
    identifyTerminal: () => undefined,
    agyWatchStates: new Map<number, AgyWatchState>(),
    agyUsageStates: new Map<number, AgyUsageState>(),
    notifyHook: vi.fn(),
    shouldApplyHookState: () => true,
    sessionProviderFor: () => null,
    hookChannelRecorder: createHookChannelRecorder(),
    debug: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
  return deps as AgyWatchLoopDeps & {
    notifyHook: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    logError: ReturnType<typeof vi.fn>;
  };
}

describe('createAgyWatchLoop', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when there are no terminals', () => {
    const store = openStore(':memory:');
    const deps = baseDeps(store);
    const loop = createAgyWatchLoop(deps);

    loop.run();

    expect(deps.debug).toHaveBeenCalledWith('[agy] sweep tick: 0 terminals');
    expect(deps.notifyHook).not.toHaveBeenCalled();
  });

  it('skips terminals that are not antigravity sessions', () => {
    const store = openStore(':memory:');
    const named: AgyTerminalNamed = { ticketId: 7, identity: { provider: 'claude' } };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });
    const loop = createAgyWatchLoop(deps);

    loop.run();

    expect(deps.notifyHook).not.toHaveBeenCalled();
  });

  it('logs and skips a named terminal with no matching worktree', () => {
    const store = openStore(':memory:');
    const named: AgyTerminalNamed = { ticketId: 7, identity: { provider: 'antigravity' } };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });
    const loop = createAgyWatchLoop(deps);

    loop.run();

    expect(deps.debug).toHaveBeenCalledWith('[agy] ticket 7: no worktree found');
    expect(deps.notifyHook).not.toHaveBeenCalled();
  });

  it('is re-entrancy-safe: a nested call while a sweep is in flight is a no-op', () => {
    const store = openStore(':memory:');
    const listTerminals = vi.fn(() => []);
    let loop: ReturnType<typeof createAgyWatchLoop>;
    const deps = baseDeps(store, {
      listTerminals,
      debug: vi.fn(() => {
        // Simulate a reentrant tick firing mid-sweep (e.g. a synchronous
        // second timer callback). It must be a no-op: the flag is still held.
        loop.run();
      }),
    });
    loop = createAgyWatchLoop(deps);

    loop.run();

    // One outer call, one nested no-op call swallowed by the guard — the
    // terminal list must only be read once.
    expect(listTerminals).toHaveBeenCalledTimes(1);
  });

  it('emits SessionStart via dispatchHook, dedupes per-ticket state, and reports no worktree scan when snapshot exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    fixtureDb(dir, '11111111-1111-4111-8111-111111111111', worktreePath, false);

    const store = openStore(':memory:');
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    seedWorktree(store, ticketId, worktreePath);

    const named: AgyTerminalNamed = { ticketId, identity: { provider: 'antigravity' } };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });

    const loop = createAgyWatchLoop(deps);
    withHome(dir, () => loop.run());

    expect(deps.notifyHook).toHaveBeenCalledTimes(1);
    expect(deps.notifyHook).toHaveBeenCalledWith(
      ticketId,
      expect.objectContaining({
        hook_event_name: 'SessionStart',
        cwd: worktreePath,
        session_id: '11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(deps.agyWatchStates.get(ticketId)).toEqual({
      dbPath: join(dir, '.gemini', 'antigravity-cli', 'conversations', '11111111-1111-4111-8111-111111111111.db'),
      started: true,
      awaiting: false,
    });
  });

  it('does not persist per-ticket lifecycle state when no conversation DB is found yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    // No conversations/ dir at all — findConversationForWorktree returns null.

    const store = openStore(':memory:');
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    seedWorktree(store, ticketId, worktreePath);

    const named: AgyTerminalNamed = { ticketId, identity: { provider: 'antigravity' } };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });

    const loop = createAgyWatchLoop(deps);
    withHome(dir, () => loop.run());

    expect(deps.notifyHook).not.toHaveBeenCalled();
    // The events.length === 0 branch never persists agyWatchStates — matches
    // the pre-extraction behavior exactly (a quirk preserved on purpose).
    expect(deps.agyWatchStates.has(ticketId)).toBe(false);
  });

  it('reports a failed conversation read through logError and continues the sweep', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    // `conversations` exists as a FILE, not a directory: findConversationForWorktree's
    // default `listDbs` sees it via `existsSync` and then `readdirSync`s it,
    // which throws ENOTDIR — the read failure this test exercises.
    mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(dir, '.gemini', 'antigravity-cli', 'conversations'), 'not a directory');

    const store = openStore(':memory:');
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    seedWorktree(store, ticketId, worktreePath);

    const named: AgyTerminalNamed = { ticketId, identity: { provider: 'antigravity' } };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });

    const loop = createAgyWatchLoop(deps);
    withHome(dir, () => expect(() => loop.run()).not.toThrow());

    expect(deps.logError).toHaveBeenCalledWith(
      `karst: agy conversation read failed for ticket ${ticketId}`,
      expect.anything(),
    );
  });
});
