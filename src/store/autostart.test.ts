import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, findTicketById, setStageCurrent, updateTicketFields } from './tickets.js';
import { setStage } from './stages.js';
import { addRelation } from './ticketRelations.js';
import {
  claimAutostart,
  queueAutostart,
  releaseAutostart,
  requeueStaleClaims,
} from './autostart.js';

const CAPS = { perParent: 2, total: 4 };
const opened: Store[] = [];
const dirs: string[] = [];
let store: Store;
let projectId: number;
let parentId: number;
let n = 0;

function open(path = ':memory:'): Store {
  const s = openStore(path);
  opened.push(s);
  return s;
}

function child(s: Store = store, parent = parentId, queued = true): number {
  n += 1;
  return createTicket(s, { key: `C-${n}`, title: 'c', projectId, subtaskParentId: parent, autostartPending: queued }).id;
}

function pending(s: Store, id: number): number {
  return (s.db.prepare('SELECT autostart_pending AS p FROM tickets WHERE id = ?').get(id) as { p: number }).p;
}

beforeEach(() => {
  store = open();
  projectId = upsertProject(store, { slug: 'p' }).id;
  parentId = createTicket(store, { key: 'P-1', title: 'p', projectId }).id;
  setStageCurrent(store, parentId, 'impl');
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('claimAutostart', () => {
  it('moves queued (1) to starting (2), stamps claimed_at, wins once', () => {
    const id = child();
    expect(claimAutostart(store, id, CAPS)).toBe(true);
    expect(pending(store, id)).toBe(2);
    expect(findTicketById(store, id)?.autostartStarting).toBe(true);
    expect(findTicketById(store, id)?.autostartPending).toBe(false);
    expect(claimAutostart(store, id, CAPS)).toBe(false);
  });

  it('refuses unqueued, missing, archived or non-scope tickets', () => {
    expect(claimAutostart(store, child(store, parentId, false), CAPS)).toBe(false);
    expect(claimAutostart(store, 9999, CAPS)).toBe(false);
    const past = child();
    setStageCurrent(store, past, 'impl');
    expect(claimAutostart(store, past, CAPS)).toBe(false);
  });

  it('counts starting (2) claims as slots for the per-parent cap', () => {
    const [a, b, c] = [child(), child(), child()];
    expect(claimAutostart(store, a!, CAPS)).toBe(true);
    expect(claimAutostart(store, b!, CAPS)).toBe(true);
    expect(claimAutostart(store, c!, CAPS)).toBe(false);
    expect(pending(store, c!)).toBe(1);
  });

  it('enforces the project-wide cap in the same statement; 0 = unlimited', () => {
    const p2 = createTicket(store, { key: 'P-2', title: 'p', projectId }).id;
    setStageCurrent(store, p2, 'impl');
    const ids = [child(), child(), child(store, p2), child(store, p2), child(store, p2)];
    const res = ids.map((id) => claimAutostart(store, id, { perParent: 0, total: 3 }));
    expect(res).toEqual([true, true, true, false, false]);
    expect(claimAutostart(store, ids[4]!, { perParent: 0, total: 0 })).toBe(true);
  });

  it('two connections on one DB file interleaving claims never exceed the caps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claim-'));
    dirs.push(dir);
    const file = join(dir, 'k.db');
    const a = open(file);
    const b = open(file);
    projectId = upsertProject(a, { slug: 'p' }).id;
    const parent = createTicket(a, { key: 'P-1', title: 'p', projectId }).id;
    setStageCurrent(a, parent, 'impl');
    const ids = [1, 2, 3, 4, 5].map(() => child(a, parent));
    let wins = 0;
    for (const id of ids) {
      if (claimAutostart(a, id, CAPS)) wins += 1;
      if (claimAutostart(b, id, CAPS)) wins += 1;
    }
    expect(wins).toBe(2);
    const starting = a.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE autostart_pending = 2').get() as { n: number };
    expect(starting.n).toBe(2);
  });
});

describe('releaseAutostart', () => {
  it('releases a starting claim to none (no retry) and clears claimed_at', () => {
    const id = child();
    claimAutostart(store, id, CAPS);
    releaseAutostart(store, id);
    expect(pending(store, id)).toBe(0);
    expect(findTicketById(store, id)?.autostartClaimedAt).toBeNull();
  });

  it('never touches a queued (1) ticket', () => {
    const id = child();
    releaseAutostart(store, id);
    expect(pending(store, id)).toBe(1);
  });
});

describe('requeueStaleClaims', () => {
  it('re-queues a starting claim at scope older than the threshold, leaves fresh ones', () => {
    const stale = child();
    const fresh = child();
    claimAutostart(store, stale, CAPS);
    claimAutostart(store, fresh, CAPS);
    store.db
      .prepare("UPDATE tickets SET autostart_claimed_at = datetime('now', '-11 minutes') WHERE id = ?")
      .run(stale);
    expect(requeueStaleClaims(store, projectId, 10 * 60_000)).toBe(1);
    expect(pending(store, stale)).toBe(1);
    expect(findTicketById(store, stale)?.autostartClaimedAt).toBeNull();
    expect(pending(store, fresh)).toBe(2);
  });
});

describe('queueAutostart', () => {
  it('queues only from none at scope; never touches starting', () => {
    const id = child(store, parentId, false);
    expect(queueAutostart(store, id)).toBe(true);
    expect(pending(store, id)).toBe(1);
    expect(queueAutostart(store, id)).toBe(false);
    claimAutostart(store, id, CAPS);
    expect(queueAutostart(store, id)).toBe(false);
    expect(pending(store, id)).toBe(2);
    const past = child(store, parentId, false);
    setStageCurrent(store, past, 'impl');
    expect(queueAutostart(store, past)).toBe(false);
  });
});

describe('setStage clears autostart when scope passes', () => {
  it('a starting claim drops to none once scope passes', () => {
    const id = child();
    claimAutostart(store, id, CAPS);
    setStage(store, id, 'scope', { status: 'passed' });
    expect(pending(store, id)).toBe(0);
    expect(findTicketById(store, id)?.autostartClaimedAt).toBeNull();
  });

  it('other stage writes leave the queue alone', () => {
    const id = child();
    setStage(store, id, 'scope', { status: 'running' });
    setStage(store, id, 'impl', { status: 'passed' });
    expect(pending(store, id)).toBe(1);
  });
});

describe('blocked tickets', () => {
  it('queueAutostart queues a blocked sub-task', () => {
    const blocker = createTicket(store, { key: 'B', title: 'b', projectId }).id;
    updateTicketFields(store, blocker, { sourceRef: 'B-1' });
    const id = child(store, parentId, false);
    updateTicketFields(store, id, { sourceRef: 'C-1' });
    addRelation(store, { ticketId: id, kind: 'blocked-by', targetTicketId: blocker, source: 'user' });

    expect(queueAutostart(store, id)).toBe(true);
    expect(pending(store, id)).toBe(1);
  });

  it('claimAutostart refuses a blocked sub-task but claims it after the blocker is done', () => {
    const blocker = createTicket(store, { key: 'B', title: 'b', projectId }).id;
    updateTicketFields(store, blocker, { sourceRef: 'B-1' });
    const id = child();
    updateTicketFields(store, id, { sourceRef: 'C-1' });
    addRelation(store, { ticketId: id, kind: 'blocked-by', targetTicketId: blocker, source: 'user' });

    expect(claimAutostart(store, id, CAPS)).toBe(false);
    expect(pending(store, id)).toBe(1);

    setStageCurrent(store, blocker, 'done');
    expect(claimAutostart(store, id, CAPS)).toBe(true);
    expect(pending(store, id)).toBe(2);
  });

  it('claimAutostart refuses a blocked sub-task with an unresolved ref', () => {
    const id = child();
    updateTicketFields(store, id, { sourceRef: 'C-1' });
    addRelation(store, { ticketId: id, kind: 'blocked-by', targetRef: 'CU-GHOST', source: 'user' });

    expect(claimAutostart(store, id, CAPS)).toBe(false);
    expect(pending(store, id)).toBe(1);
  });
});
