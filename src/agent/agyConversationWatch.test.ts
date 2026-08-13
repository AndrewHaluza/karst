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

function fixtureDb(
  dir: string,
  name: string,
  workspacePath: string,
  pending: boolean,
  usageFixtures?: { idx: number; step_type: number; metadataHex: string }[],
): string {
  const conversationsDir = join(dir, 'conversations');
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
  if (usageFixtures) {
    const insert = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    for (const row of usageFixtures) {
      insert.run(row.idx, row.step_type, Buffer.from(row.metadataHex, 'hex'));
    }
  }
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

  describe('usage()', () => {
    const TYPE15_HEX =
      '0a0b08d1e4f6d30610b0bde30e1802320c08d6e4f6d30610a8ce9efd013a0c08d6e4f6d30610f0aca6b302420c08d6e4f6d30610f0aca6b3024a4f088c0810894c18a00228ae3f301842210a0973657373696f6e494412142d33373530373633303334333632383935353739489b0250055a1755624a39616f6948494c434632386f5076365063734138588c08622430306366303937322d316631372d343865322d383263612d3663616237616230326433636a03088c08a2014e0a2434326636386230342d633632632d346638382d396365642d6264346139316564393763361003222462393732326632662d333833312d346337372d393136372d633134666235333432363435a80101d201240a100808120c08d6e4f6d3061080ffa0fd010a100803120c08d6e4f6d30610f8caa9b30282020c08d6e4f6d30610f0aca6b302';
    const TYPE23_HEX =
      '0a0c08d6e4f6d30610c0ec90b5021805420b08d7e4f6d3061088f1b8704a47089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f724834734134622430306366303937322d316631372d343865322d383263612d366361623761623032643363a201500a2434326636386230342d633632632d346638382d396365642d62643461393165643937633610041801222462393732326632662d333833312d346337372d393136372d633134666235333432363435d201350a100801120c08d6e4f6d30610e08b91b5020a100802120c08d6e4f6d30610d8a5a5b5020a0f0803120b08d7e4f6d30610f89fb970e201491247089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f72483473413482020c08d6e4f6d3061098fc9db502';

    it('returns null on a DB with no usage rows', () => {
      dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
      const dbPath = fixtureDb(dir, '11111111-1111-4111-8111-111111111111', '/wt', false);
      const db = openAgyConversationDb(dbPath);
      expect(db.usage()).toBeNull();
      db.close();
    });

    it('returns cumulative usage from type-15 and type-23 steps', () => {
      dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
      const dbPath = fixtureDb(
        dir,
        '11111111-1111-4111-8111-111111111111',
        '/wt',
        false,
        [
          { idx: 3, step_type: 15, metadataHex: TYPE15_HEX },
          { idx: 4, step_type: 23, metadataHex: TYPE23_HEX },
        ],
      );
      const db = openAgyConversationDb(dbPath);
      expect(db.usage()).toEqual({
        input: 9836,
        output: 292,
        cacheRead: 8110,
        lastStepIdx: 4,
      });
      db.close();
    });

    it('returns the same cumulative on a second call (read-only, no mutation)', () => {
      dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
      const dbPath = fixtureDb(
        dir,
        '11111111-1111-4111-8111-111111111111',
        '/wt',
        false,
        [
          { idx: 3, step_type: 15, metadataHex: TYPE15_HEX },
          { idx: 4, step_type: 23, metadataHex: TYPE23_HEX },
        ],
      );
      const db = openAgyConversationDb(dbPath);
      const first = db.usage();
      const second = db.usage();
      expect(second).toEqual(first);
      db.close();
    });
  });
});
