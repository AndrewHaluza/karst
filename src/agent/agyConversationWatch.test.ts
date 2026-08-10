import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  agyWatchTick,
  findConversationForWorktree,
  openAgyConversationDb,
  resolveAgyAppDataDir,
  type AgyConversationSnapshot,
  type AgyWatchState,
} from './agyConversationWatch.js';

function fixtureDb(dir: string, name: string, workspacePath: string, pending: boolean): string {
  const conversationsDir = join(dir, 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  const dbPath = join(conversationsDir, `${name}.db`);
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);' +
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0);',
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

describe('agyConversationWatch', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the app-data dir from the env override, else the home default', () => {
    expect(resolveAgyAppDataDir({ ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/custom/data' }, '/home/u')).toBe(
      '/custom/data',
    );
    expect(resolveAgyAppDataDir({}, '/home/u')).toBe('/home/u/.gemini/antigravity-cli');
  });

  it('finds the conversation DB whose workspace blob names the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const wt = '/Users/nd/Work/projects/karst/.karst/worktrees/869eg9fke-fix-ticket';
    const expected = fixtureDb(dir, '11111111-1111-4111-8111-111111111111', wt, false);
    fixtureDb(dir, '22222222-2222-4222-8222-222222222222', '/some/other/worktree', false);
    const found = findConversationForWorktree(dir, wt);
    expect(found).toEqual({
      dbPath: expected,
      conversationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('returns null when no conversation names the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    fixtureDb(dir, '11111111-1111-4111-8111-111111111111', '/somewhere/else', false);
    expect(findConversationForWorktree(dir, '/Users/nd/other')).toBeNull();
  });

  it('picks the NEWEST db when two conversations share the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const older = fixtureDb(dir, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '/wt/shared', false);
    const newer = fixtureDb(dir, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '/wt/shared', false);
    const later = Date.now() + 10_000;
    utimesSync(older, new Date(later - 60_000), new Date(later - 60_000));
    utimesSync(newer, new Date(later), new Date(later));
    const found = findConversationForWorktree(dir, '/wt/shared');
    expect(found?.conversationId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('reads pendingApproval from a status=9 step', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const dbPath = fixtureDb(dir, '11111111-1111-4111-8111-111111111111', '/wt', true);
    const db = openAgyConversationDb(dbPath);
    expect(db.pendingApprovalCount()).toBe(1);
    db.close();
  });

  it('emits SessionStart on first observation, then permission.asked when a step is pending', () => {
    const state: AgyWatchState = { dbPath: null, started: false, awaiting: false };
    const first: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: true,
    };
    expect(agyWatchTick(state, first)).toEqual([
      { kind: 'SessionStart', sessionId: 'c1' },
      { kind: 'permission.asked' },
    ]);
    expect(state).toEqual({ dbPath: '/data/conversations/c1.db', started: true, awaiting: true });
  });

  it('emits nothing on an unchanged pending step', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: true,
    };
    const same: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: true,
    };
    expect(agyWatchTick(state, same)).toEqual([]);
  });

  it('emits UserPromptSubmit when the pending step resolves', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: true,
    };
    const resolved: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: false,
    };
    expect(agyWatchTick(state, resolved)).toEqual([{ kind: 'UserPromptSubmit' }]);
    expect(state.awaiting).toBe(false);
  });

  it('emits nothing when no conversation is found yet', () => {
    const state: AgyWatchState = { dbPath: null, started: false, awaiting: false };
    expect(agyWatchTick(state, null)).toEqual([]);
  });

  it('treats a NEW conversation db for the same worktree as a fresh session', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: false,
    };
    const fresh: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c2.db',
      conversationId: 'c2',
      pendingApproval: false,
    };
    expect(agyWatchTick(state, fresh)).toEqual([{ kind: 'SessionStart', sessionId: 'c2' }]);
  });
});
