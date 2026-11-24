import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  purgeArchivedGateLogs,
  removeGateLogDir,
  type PurgeArchivedGateLogsDeps,
} from './gateLogRetention.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-24T12:00:00.000Z');
const MAX_AGE_DAYS = 30;
const CUTOFF = NOW.getTime() - MAX_AGE_DAYS * DAY_MS;
const OLD = new Date('2026-01-01T00:00:00.000Z');
/** The SQLite `datetime('now')` shape `archiveTicket` writes (UTC, no zone). */
const OLD_SQLITE = '2026-01-01 00:00:00';
const OLD_ISO = '2026-01-01T00:00:00.000Z';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'karst-gatelog-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWithMtime(path: string, when: Date): void {
  writeFileSync(path, 'gate log\n');
  utimesSync(path, when, when);
}

function makeDeps(
  archived: Record<number, string | null | undefined>,
  extra: Partial<PurgeArchivedGateLogsDeps> = {},
): PurgeArchivedGateLogsDeps {
  return { archivedAt: (id) => archived[id], now: () => NOW, debug: () => {}, ...extra };
}

describe('removeGateLogDir', () => {
  it('removes a populated dir and tolerates one that is already gone', async () => {
    const dir = makeDir('7');
    mkdirSync(join(dir, 'nested'));
    writeWithMtime(join(dir, 'uat-ticket-7-1.log'), OLD);
    writeWithMtime(join(dir, 'nested', 'review-7.log'), OLD);

    await removeGateLogDir(dir);

    expect(existsSync(dir)).toBe(false);
    await expect(removeGateLogDir(dir)).resolves.toBeUndefined();
  });
});

describe('purgeArchivedGateLogs', () => {
  it('removes an archived ticket whose SQLite archived_at and files are old', async () => {
    const dir = makeDir('7');
    writeWithMtime(join(dir, 'uat-ticket-7-1.log'), OLD);
    const debug: string[] = [];

    const removed = await purgeArchivedGateLogs(
      root,
      MAX_AGE_DAYS,
      makeDeps({ 7: OLD_SQLITE }, { debug: (m) => debug.push(m) }),
    );

    expect(removed).toEqual([7]);
    expect(existsSync(dir)).toBe(false);
    expect(debug).toEqual([]);
  });

  it('removes an archived ticket whose archived_at is ISO-8601', async () => {
    const dir = makeDir('8');
    writeWithMtime(join(dir, 'review-8.log'), OLD);

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 8: OLD_ISO }));

    expect(removed).toEqual([8]);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes an archived ticket whose dir is empty', async () => {
    const dir = makeDir('9');

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 9: OLD_SQLITE }));

    expect(removed).toEqual([9]);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a dir with one old and one new file', async () => {
    const dir = makeDir('10');
    writeWithMtime(join(dir, 'old.log'), OLD);
    writeWithMtime(join(dir, 'new.log'), NOW);

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 10: OLD_SQLITE }));

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir whose newest file sits exactly on the cutoff', async () => {
    const dir = makeDir('11');
    writeWithMtime(join(dir, 'boundary.log'), new Date(CUTOFF));

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 11: OLD_SQLITE }));

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir with a new file inside a nested subdirectory', async () => {
    const dir = makeDir('12');
    const nested = join(dir, 'run-1');
    mkdirSync(nested);
    writeWithMtime(join(dir, 'old.log'), OLD);
    writeWithMtime(join(nested, 'agent-review-12.log'), NOW);
    // The nested dir's OWN mtime stays old, so only a recurse finds the new file.
    utimesSync(nested, OLD, OLD);

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 12: OLD_SQLITE }));

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir whose archived_at is exactly on the cutoff', async () => {
    const dir = makeDir('13');
    writeWithMtime(join(dir, 'old.log'), OLD);

    const removed = await purgeArchivedGateLogs(
      root,
      MAX_AGE_DAYS,
      makeDeps({ 13: new Date(CUTOFF).toISOString() }),
    );

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir whose archived_at is newer than the cutoff', async () => {
    const dir = makeDir('14');
    writeWithMtime(join(dir, 'old.log'), OLD);

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 14: NOW.toISOString() }));

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a dir whose archived_at is unparseable', async () => {
    const dir = makeDir('15');
    writeWithMtime(join(dir, 'old.log'), OLD);

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, makeDeps({ 15: 'not-a-date' }));

    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps the dir of a ticket that is not archived', async () => {
    const dir = makeDir('16');
    writeWithMtime(join(dir, 'old.log'), OLD);
    const debug: string[] = [];

    const removed = await purgeArchivedGateLogs(
      root,
      MAX_AGE_DAYS,
      makeDeps({ 16: null }, { debug: (m) => debug.push(m) }),
    );

    expect(removed).toEqual([]);
    expect(debug).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps the dir of a missing or other-project ticket (the orphan reaper owns it)', async () => {
    const dir = makeDir('17');
    writeWithMtime(join(dir, 'old.log'), OLD);
    const debug: string[] = [];

    const removed = await purgeArchivedGateLogs(
      root,
      MAX_AGE_DAYS,
      makeDeps({ 17: undefined }, { debug: (m) => debug.push(m) }),
    );

    expect(removed).toEqual([]);
    expect(debug).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('never touches p<n> stores, non-numeric dirs, numeric files, or symlinks', async () => {
    const target = makeDir('target');
    writeWithMtime(join(target, 'old.log'), OLD);
    const store = makeDir('p1');
    writeWithMtime(join(store, 'old.log'), OLD);
    const captures = makeDir('captures');
    writeWithMtime(join(captures, 'old.log'), OLD);
    const mixed = makeDir('12x');
    writeWithMtime(join(mixed, 'old.log'), OLD);
    writeWithMtime(join(root, '99'), OLD);
    symlinkSync(target, join(root, '5'), 'dir');
    const archived = makeDir('18');
    writeWithMtime(join(archived, 'old.log'), OLD);

    const removed = await purgeArchivedGateLogs(
      root,
      MAX_AGE_DAYS,
      // Every name that reaches the predicate is archived, so only the name
      // test and the `isDirectory()` test can keep the four dirs alive.
      makeDeps({ 5: OLD_SQLITE, 12: OLD_SQLITE, 18: OLD_SQLITE, 99: OLD_SQLITE }),
    );

    expect(removed).toEqual([18]);
    expect(existsSync(store)).toBe(true);
    expect(existsSync(captures)).toBe(true);
    expect(existsSync(mixed)).toBe(true);
    expect(existsSync(join(root, '99'))).toBe(true);
    expect(existsSync(join(root, '5'))).toBe(true);
    expect(existsSync(join(target, 'old.log'))).toBe(true);
    expect(existsSync(archived)).toBe(false);
  });

  it('returns [ ] and names the root when it does not exist', async () => {
    const debug: string[] = [];

    const removed = await purgeArchivedGateLogs(
      join(root, 'absent'),
      MAX_AGE_DAYS,
      makeDeps({}, { debug: (m) => debug.push(m) }),
    );

    expect(removed).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('[artifacts] gate-log retention');
    expect(debug[0]).toContain(join(root, 'absent'));
  });

  it('logs a per-dir failure with its ticket and still removes the next one', async () => {
    const locked = makeDir('1');
    writeWithMtime(join(locked, 'old.log'), OLD);
    const lying = makeDir('2');
    writeWithMtime(join(lying, 'old.log'), OLD);
    const removable = makeDir('3');
    writeWithMtime(join(removable, 'old.log'), OLD);
    const debug: string[] = [];

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, {
      archivedAt: (id) => {
        if (id === 2) throw 'store said no';
        return OLD_SQLITE;
      },
      now: () => NOW,
      debug: (m) => debug.push(m),
      removeDir: async (path) => {
        if (path === locked) throw new Error('locked by another process');
        await removeGateLogDir(path);
      },
    });

    expect(removed).toEqual([3]);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(lying)).toBe(true);
    expect(existsSync(removable)).toBe(false);
    expect(debug).toEqual([
      '[artifacts] gate-log retention: failed on ticket 1: locked by another process',
      '[artifacts] gate-log retention: failed on ticket 2: store said no',
    ]);
  });

  it('keeps a dir whose ticket is unarchived during the file walk', async () => {
    const dir = makeDir('19');
    writeWithMtime(join(dir, 'old.log'), OLD);
    let calls = 0;

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, {
      archivedAt: () => {
        calls += 1;
        return calls === 1 ? OLD_SQLITE : null;
      },
      now: () => NOW,
      debug: () => {},
    });

    expect(calls).toBe(2);
    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('defaults `now` to the current clock', async () => {
    const dir = makeDir('20');
    writeWithMtime(join(dir, 'old.log'), new Date('2020-01-01T00:00:00.000Z'));

    const removed = await purgeArchivedGateLogs(root, MAX_AGE_DAYS, {
      archivedAt: () => '2020-01-01 00:00:00',
      debug: () => {},
    });

    expect(removed).toEqual([20]);
    expect(existsSync(dir)).toBe(false);
  });
});
