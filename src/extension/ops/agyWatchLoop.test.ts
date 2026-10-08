import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { openStore, type Store } from '../../store/db.js';
import { createHookChannelRecorder } from '../../diagnostics/hookChannel.js';
import { createAgyWatchLoop, type AgyTerminalNamed, type AgyWatchLoopDeps } from './agyWatchLoop.js';
import { AGY_SUMMARIES_DB, type AgyWatchState } from '../../agent/agyConversationWatch.js';
import type { AgyUsageState } from '../../agent/agyUsageWatch.js';

// `dispatchHook` is observed through a spy that keeps the real implementation:
// the loop must still post real lifecycle/usage events, but the usage payloads
// (which only reach the store when a provider binding exists) are asserted
// directly on the call.
const dispatchRef = vi.hoisted(() => ({
  actual: undefined as unknown as (...args: unknown[]) => unknown,
}));
vi.mock('../../hooks/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/dispatch.js')>();
  dispatchRef.actual = actual.dispatchHook as unknown as (...args: unknown[]) => unknown;
  return { ...actual, dispatchHook: vi.fn(actual.dispatchHook) };
});
import { dispatchHook, type HookDispatchResult } from '../../hooks/dispatch.js';

/**
 * `resolveAgyAppDataDir()` — called with no args by the loop, exactly as the
 * pre-extraction inline code called it — never reads `ANTIGRAVITY_EXECUTABLE_DATA_DIR`
 * (that requires an explicit `env` argument neither call site passes); it
 * resolves to `homedir()/.gemini/antigravity-cli`. `os.homedir()` is mocked
 * rather than redirecting `$HOME`: under worker threads (Stryker's vitest
 * runner) a `process.env.HOME` write only touches the worker's env copy while
 * libuv's `homedir()` reads the real process env, so the sweep would miss the
 * fixture tree.
 */
const homeRef = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => homeRef.current ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

function withHome<T>(home: string, fn: () => T): T {
  const prev = homeRef.current;
  homeRef.current = home;
  try {
    return fn();
  } finally {
    homeRef.current = prev;
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

// Verbatim usage-bearing step metadata from a real agy 1.1.12 DB (see
// agyUsageWatch.test.ts). idx=3 reports input 9737 / output 288 / cache_read
// 8110; idx=4 reports input 99 / output 4 / cache_read 0.
const USAGE_STEP_3 = Buffer.from(
  '0a0b08d1e4f6d30610b0bde30e1802320c08d6e4f6d30610a8ce9efd013a0c08d6e4f6d30610f0aca6b302420c08d6e4f6d30610f0aca6b3024a4f088c0810894c18a00228ae3f301842210a0973657373696f6e494412142d33373530373633303334333632383935353739489b0250055a1755624a39616f6948494c434632386f5076365063734138588c08622430306366303937322d316631372d343865322d383263612d3663616237616230326433636a03088c08a2014e0a2434326636386230342d633632632d346638382d396365642d6264346139316564393763361003222462393732326632662d333833312d346337372d393136372d633134666235333432363435a80101d201240a100808120c08d6e4f6d3061080ffa0fd010a100803120c08d6e4f6d30610f8caa9b30282020c08d6e4f6d30610f0aca6b302',
  'hex',
);
const USAGE_STEP_4 = Buffer.from(
  '0a0c08d6e4f6d30610c0ec90b5021805420b08d7e4f6d3061088f1b8704a47089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f724834734134622430306366303937322d316631372d343865322d383263612d366361623761623032643363a201500a2434326636386230342d633632632d346638382d396365642d62643461393165643937633610041801222462393732326632662d333833312d346337372d393136372d633134666235333432363435d201350a100801120c08d6e4f6d30610e08b91b5020a100802120c08d6e4f6d30610d8a5a5b5020a0f0803120b08d7e4f6d30610f89fb970e201491247089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f72483473413482020c08d6e4f6d3061098fc9db502',
  'hex',
);

/** Append a model-call step (with usage metadata) to a fixture conversation DB. */
function insertUsageStep(dbPath: string, idx: number, metadata: Buffer): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)').run(
    idx,
    metadata,
  );
  db.close();
}

/** Flip a step's status in a fixture conversation DB (9 = pending, 3 = answered). */
function setStepStatus(dbPath: string, idx: number, status: number): void {
  const db = new Database(dbPath);
  db.prepare('UPDATE steps SET status = ? WHERE idx = ?').run(status, idx);
  db.close();
}

/** The app-data dir the mocked homedir resolves to. */
function agyAppDataDir(home: string): string {
  return join(home, '.gemini', 'antigravity-cli');
}

/** Write the CLI's summary DB with one conversation's run status. */
function summaryFixture(home: string, conversationId: string, status: string): void {
  const appDataDir = agyAppDataDir(home);
  mkdirSync(appDataDir, { recursive: true });
  const db = new Database(join(appDataDir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, status TEXT);');
  db.prepare('INSERT INTO conversation_summaries (conversation_id, status) VALUES (?, ?)').run(
    conversationId,
    status,
  );
  db.close();
}

/** Change one conversation's run status in the fixture summary DB. */
function setSummaryStatus(home: string, conversationId: string, status: string): void {
  const db = new Database(join(agyAppDataDir(home), 'conversation_summaries.db'));
  db.prepare('UPDATE conversation_summaries SET status = ? WHERE conversation_id = ?').run(
    status,
    conversationId,
  );
  db.close();
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
  beforeEach(() => {
    vi.mocked(dispatchHook).mockReset();
    vi.mocked(dispatchHook).mockImplementation(dispatchRef.actual as never);
  });
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
      // No summary DB in the fixture → the run status is UNKNOWN, not running.
      idle: null,
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
    // The null-snapshot debug line names every optional field explicitly.
    expect(deps.debug).toHaveBeenCalledWith(
      `[agy] ticket ${ticketId}: conversation=none, usage=null, launchId=none, idle=none`,
    );
    // A missing conversation is not a read failure.
    expect(deps.logError).not.toHaveBeenCalled();
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

  it('dispatches SessionStart then the UsageUpdate payload, passing the loop debug through', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '11111111-1111-4111-8111-111111111111';
    const dbPath = fixtureDb(dir, convId, worktreePath, false);
    insertUsageStep(dbPath, 3, USAGE_STEP_3);

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

    // The lifecycle event still posts through the real dispatch (notify seam).
    expect(deps.notifyHook).toHaveBeenCalledWith(
      ticketId,
      expect.objectContaining({
        hook_event_name: 'SessionStart',
        cwd: worktreePath,
        session_id: convId,
      }),
    );

    const usageCalls = vi
      .mocked(dispatchHook)
      .mock.calls.filter(
        (c) => (c[1] as { hook_event_name?: string }).hook_event_name === 'UsageUpdate',
      );
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]![1]).toEqual({
      hook_event_name: 'UsageUpdate',
      cwd: worktreePath,
      session_id: convId,
      usage: { event_id: '3', input: 9737, output: 288, cache_read: 8110, total: 10025 },
    });
    // The found-conversation debug line names conversation, usage and launch id.
    expect(deps.debug).toHaveBeenCalledWith(
      `[agy] ticket ${ticketId}: conversation=${convId}, usage=9737/288/8110, launchId=none, idle=null`,
    );
    // The events path injects the loop's debug into dispatch (passDebugToDispatch: true)
    // and does NOT log each usage event itself (logEachEvent: false).
    expect(usageCalls[0]!.length).toBe(7);
    expect(usageCalls[0]![6]).toBe(deps.debug);
    expect(deps.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('dispatching UsageUpdate'),
    );
    // The usage watch state is persisted so a re-sweep of the same DB is silent.
    expect(deps.agyUsageStates.get(ticketId)).toEqual({ eventId: '3' });

    vi.mocked(dispatchHook).mockClear();
    withHome(dir, () => loop.run());
    expect(
      vi
        .mocked(dispatchHook)
        .mock.calls.filter(
          (c) => (c[1] as { hook_event_name?: string }).hook_event_name === 'UsageUpdate',
        ),
    ).toHaveLength(0);
  });

  it('logs each usage event and omits the debug injection once the lifecycle has started', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '11111111-1111-4111-8111-111111111111';
    const dbPath = fixtureDb(dir, convId, worktreePath, false);
    insertUsageStep(dbPath, 3, USAGE_STEP_3);

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

    withHome(dir, () => loop.run()); // SessionStart + usage idx 3
    // A new model call advances the cumulative usage; the lifecycle is already
    // started and not awaiting, so this tick produces no lifecycle events.
    insertUsageStep(dbPath, 4, USAGE_STEP_4);
    vi.mocked(dispatchHook).mockClear();
    withHome(dir, () => loop.run());

    expect(deps.debug).toHaveBeenCalledWith(
      `[agy] ticket ${ticketId}: dispatching UsageUpdate event_id=4`,
    );
    const usageCalls = vi
      .mocked(dispatchHook)
      .mock.calls.filter(
        (c) => (c[1] as { hook_event_name?: string }).hook_event_name === 'UsageUpdate',
      );
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]![1]).toEqual({
      hook_event_name: 'UsageUpdate',
      cwd: worktreePath,
      session_id: convId,
      usage: { event_id: '4', input: 9836, output: 292, cache_read: 8110, total: 10128 },
    });
    // logEachEvent: true, passDebugToDispatch: false — six args, no debug.
    expect(usageCalls[0]!.length).toBe(6);
  });

  it('maps a pending approval to permission.asked and its resolution to UserPromptSubmit', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '22222222-2222-4222-8222-222222222222';
    const dbPath = fixtureDb(dir, convId, worktreePath, true);

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
    expect(deps.notifyHook).toHaveBeenCalledTimes(2);
    expect(deps.notifyHook.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ hook_event_name: 'SessionStart', session_id: convId }),
    );
    expect(deps.notifyHook.mock.calls[1]![1]).toEqual({
      hook_event_name: 'permission.asked',
      cwd: worktreePath,
      session_id: convId,
    });

    // The user answers: status 9 → 3; the ask resolves to a UserPromptSubmit
    // carrying the SAME (current) conversation id.
    setStepStatus(dbPath, 1, 3);
    withHome(dir, () => loop.run());
    expect(deps.notifyHook).toHaveBeenCalledTimes(3);
    expect(deps.notifyHook.mock.calls[2]![1]).toEqual({
      hook_event_name: 'UserPromptSubmit',
      cwd: worktreePath,
      session_id: convId,
    });
  });

  it('emits a Stop when the summary run status turns idle, and records the idle flag', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '66666666-6666-4666-8666-666666666666';
    fixtureDb(dir, convId, worktreePath, false);
    summaryFixture(dir, convId, 'CASCADE_RUN_STATUS_RUNNING');

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
    // Running: SessionStart only, idle flag false.
    expect(deps.notifyHook).toHaveBeenCalledTimes(1);
    expect(deps.agyWatchStates.get(ticketId)?.idle).toBe(false);

    // The turn ends: the run status flips to idle.
    setSummaryStatus(dir, convId, 'CASCADE_RUN_STATUS_IDLE');
    withHome(dir, () => loop.run());

    expect(deps.notifyHook).toHaveBeenCalledTimes(2);
    expect(deps.notifyHook.mock.calls[1]![1]).toEqual({
      hook_event_name: 'Stop',
      cwd: worktreePath,
      session_id: convId,
    });
    expect(deps.agyWatchStates.get(ticketId)?.idle).toBe(true);

    // Unchanged idle emits nothing further.
    withHome(dir, () => loop.run());
    expect(deps.notifyHook).toHaveBeenCalledTimes(2);
  });

  it('does not drop the lifecycle tick when the summary DB cannot be read', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '77777777-7777-4777-8777-777777777777';
    fixtureDb(dir, convId, worktreePath, false);
    // A garbage summary file: opening/preparing it throws, which must read as
    // UNKNOWN, never abort the whole sweep before the lifecycle event posts.
    writeFileSync(join(agyAppDataDir(dir), AGY_SUMMARIES_DB), 'not a sqlite database');

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

    expect(deps.notifyHook).toHaveBeenCalledWith(
      ticketId,
      expect.objectContaining({ hook_event_name: 'SessionStart', session_id: convId }),
    );
    expect(deps.agyWatchStates.get(ticketId)?.idle).toBeNull();
    expect(deps.logError).not.toHaveBeenCalled();
  });

  it('carries the launch id on both the lifecycle and usage payloads', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '33333333-3333-4333-8333-333333333333';
    const dbPath = fixtureDb(dir, convId, worktreePath, false);
    insertUsageStep(dbPath, 3, USAGE_STEP_3);

    const store = openStore(':memory:');
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    seedWorktree(store, ticketId, worktreePath);

    const named: AgyTerminalNamed = {
      ticketId,
      launchId: 'L-1',
      identity: { provider: 'antigravity' },
    };
    const deps = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => named,
    });
    const loop = createAgyWatchLoop(deps);
    withHome(dir, () => loop.run());

    const payloads = vi.mocked(dispatchHook).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const sessionStart = payloads.find((p) => p['hook_event_name'] === 'SessionStart');
    const usage = payloads.find((p) => p['hook_event_name'] === 'UsageUpdate');
    expect(sessionStart).toMatchObject({ launchId: 'L-1' });
    expect(usage).toMatchObject({ launchId: 'L-1' });
    expect(deps.debug).toHaveBeenCalledWith(
      `[agy] ticket ${ticketId}: conversation=${convId}, usage=9737/288/8110, launchId=L-1, idle=null`,
    );
  });

  it('skips terminals it cannot name or that expose no identity', () => {
    const store = openStore(':memory:');
    const unnamed = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => undefined,
    });
    createAgyWatchLoop(unnamed).run();
    expect(unnamed.notifyHook).not.toHaveBeenCalled();
    expect(unnamed.logError).not.toHaveBeenCalled();
    expect(unnamed.debug).toHaveBeenCalledWith('[agy] sweep tick: 1 terminals');

    const noIdentity = baseDeps(store, {
      listTerminals: () => [{}],
      identifyTerminal: () => ({ ticketId: 7 }),
    });
    createAgyWatchLoop(noIdentity).run();
    expect(noIdentity.notifyHook).not.toHaveBeenCalled();
    expect(noIdentity.logError).not.toHaveBeenCalled();
  });

  it('clears the in-flight flag so consecutive sweeps each run', () => {
    const store = openStore(':memory:');
    const listTerminals = vi.fn(() => []);
    const deps = baseDeps(store, { listTerminals });
    const loop = createAgyWatchLoop(deps);

    loop.run();
    loop.run();

    expect(listTerminals).toHaveBeenCalledTimes(2);
  });

  it('reports an unexpected sweep failure through logError without throwing', () => {
    const store = openStore(':memory:');
    const deps = baseDeps(store, {
      listTerminals: () => {
        throw new Error('boom');
      },
    });
    const loop = createAgyWatchLoop(deps);

    expect(() => loop.run()).not.toThrow();
    expect(deps.logError).toHaveBeenCalledWith(
      'karst: agy conversation watch failed',
      expect.anything(),
    );
  });

  it('reports a lifecycle dispatch failure through logError and continues', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    fixtureDb(dir, '44444444-4444-4444-8444-444444444444', worktreePath, false);

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
    vi.mocked(dispatchHook).mockImplementationOnce(() => {
      throw new Error('dispatch boom');
    });
    const loop = createAgyWatchLoop(deps);

    withHome(dir, () => expect(() => loop.run()).not.toThrow());

    expect(deps.logError).toHaveBeenCalledWith(
      `karst: agy watch dispatch failed for ticket ${ticketId}`,
      expect.anything(),
    );
  });

  it('reports a usage dispatch failure through logError and continues', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-loop-'));
    const worktreePath = join(dir, 'wt');
    mkdirSync(worktreePath, { recursive: true });
    const convId = '55555555-5555-4555-8555-555555555555';
    const dbPath = fixtureDb(dir, convId, worktreePath, false);
    insertUsageStep(dbPath, 3, USAGE_STEP_3);

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
    vi.mocked(dispatchHook).mockImplementation((...args: unknown[]) => {
      const payload = args[1] as { hook_event_name?: string };
      if (payload.hook_event_name === 'UsageUpdate') throw new Error('usage boom');
      return dispatchRef.actual(...args) as HookDispatchResult;
    });
    const loop = createAgyWatchLoop(deps);

    withHome(dir, () => expect(() => loop.run()).not.toThrow());

    expect(deps.logError).toHaveBeenCalledWith(
      `karst: agy usage dispatch failed for ticket ${ticketId}`,
      expect.anything(),
    );
  });
});
