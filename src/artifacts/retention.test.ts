import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { sweepArtifactRetention, sweepArtifactTrees } from './retention.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-24T12:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');
/** The SQLite `datetime('now')` shape `archiveTicket` writes. */
const ARCHIVED_LONG_AGO = '2026-01-01 00:00:00';

let store: Store;
let root: string;

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare("INSERT INTO projects (id, slug) VALUES (1, 'mine'), (2, 'other')").run();
  root = mkdtempSync(join(tmpdir(), 'karst-artretention-'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** An archived gate-log dir as the console writer leaves it: old logs only. */
function seedGateLogs(ticketId: number): string {
  const dir = join(root, 'artifacts', String(ticketId));
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `uat-ticket-${ticketId}-1.log`);
  writeFileSync(log, 'gate log\n');
  utimesSync(log, OLD, OLD);
  return dir;
}

function ticketIn(projectId: number, key: string): number {
  const ticket = createTicket(store, { key, title: key, projectId });
  return ticket.id;
}

/** `archiveTicket` stamps `now`; retention tests need an archive long past. */
function archiveLongAgo(ticketId: number): void {
  store.db
    .prepare('UPDATE tickets SET archived_at = ? WHERE id = ?')
    .run(ARCHIVED_LONG_AGO, ticketId);
}

const noop = { debug: () => {}, logError: () => {} };

describe('sweepArtifactRetention', () => {
  it('does nothing when maxAgeDays is unset (keep forever)', async () => {
    const ticketId = ticketIn(1, 'T-1');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: undefined,
      store,
      now: () => NOW,
      ...noop,
    });

    expect(purged).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('tolerates a missing store root', async () => {
    expect(
      await sweepArtifactRetention({
        globalStorageRoot: join(root, 'absent'),
        projectId: 1,
        manifest: { artifacts: { maxAgeDays: 5 } },
        store,
        now: () => NOW,
        ...noop,
      }),
    ).toEqual([]);
  });

  it('purges the gate logs of an archived ticket in this project', async () => {
    const ticketId = ticketIn(1, 'T-2');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);
    const debug: string[] = [];

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: { artifacts: { maxAgeDays: 30 } },
      store,
      now: () => NOW,
      debug: (m) => debug.push(m),
      logError: noop.logError,
    });

    expect(purged).toEqual([ticketId]);
    expect(existsSync(dir)).toBe(false);
    expect(debug).toContain(`[artifacts] purged 1 archived ticket gate-log dir(s)`);
  });

  it("never purges another project's archived ticket gate logs", async () => {
    const ticketId = ticketIn(2, 'T-3');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: { artifacts: { maxAgeDays: 30 } },
      store,
      now: () => NOW,
      ...noop,
    });

    expect(purged).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps the gate logs of an unarchived ticket in this project', async () => {
    const ticketId = ticketIn(1, 'T-4');
    const dir = seedGateLogs(ticketId);

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: { artifacts: { maxAgeDays: 30 } },
      store,
      now: () => NOW,
      ...noop,
    });

    expect(purged).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a recently archived ticket', async () => {
    const ticketId = ticketIn(1, 'T-5');
    store.db
      .prepare('UPDATE tickets SET archived_at = ? WHERE id = ?')
      .run(NOW.toISOString(), ticketId);
    const dir = seedGateLogs(ticketId);

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: { artifacts: { maxAgeDays: 30 } },
      store,
      now: () => NOW,
      ...noop,
    });

    expect(purged).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a freshly written file in an old archived ticket', async () => {
    const ticketId = ticketIn(1, 'T-6');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);
    const recent = join(dir, 'review-1.log');
    writeFileSync(recent, 'still running\n');
    utimesSync(recent, new Date(NOW.getTime() - DAY_MS), new Date(NOW.getTime() - DAY_MS));

    const purged = await sweepArtifactRetention({
      globalStorageRoot: root,
      projectId: 1,
      manifest: { artifacts: { maxAgeDays: 30 } },
      store,
      now: () => NOW,
      ...noop,
    });

    expect(purged).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('sweepArtifactTrees', () => {
  // A T2 store failure (a corrupt repo, a git spawn error) used to abort the
  // whole sweep, so the larger gate-log tree was never reached. The passes are
  // independent: the store failure is reported and the logs still go.
  it('still purges archived gate logs when the T2 store pass fails', async () => {
    const ticketId = ticketIn(1, 'T-7');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);
    const debug: string[] = [];
    const errors: string[] = [];

    const purged = await sweepArtifactTrees({
      artifactsRoot: join(root, 'artifacts'),
      projectId: 1,
      maxAgeDays: 30,
      store,
      ticketStore: {
        purgeStale: async () => {
          throw new Error('git is not installed');
        },
      },
      now: () => NOW,
      debug: (m) => debug.push(m),
      logError: (m) => errors.push(m),
    });

    expect(purged).toEqual([ticketId]);
    expect(existsSync(dir)).toBe(false);
    expect(errors).toEqual(['karst: artifact store retention sweep failed']);
    expect(debug).toEqual(['[artifacts] purged 1 archived ticket gate-log dir(s)']);
  });

  it('reports both passes and returns a ticket that both purged only once', async () => {
    const ticketId = ticketIn(1, 'T-8');
    archiveLongAgo(ticketId);
    const dir = seedGateLogs(ticketId);
    const debug: string[] = [];

    const purged = await sweepArtifactTrees({
      artifactsRoot: join(root, 'artifacts'),
      projectId: 1,
      maxAgeDays: 30,
      store,
      ticketStore: { purgeStale: async () => [ticketId] },
      now: () => NOW,
      debug: (m) => debug.push(m),
      logError: noop.logError,
    });

    expect(purged).toEqual([ticketId]);
    expect(existsSync(dir)).toBe(false);
    expect(debug).toEqual([
      '[artifacts] purged 1 stale ticket store(s)',
      '[artifacts] purged 1 archived ticket gate-log dir(s)',
    ]);
  });
});
