import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { archiveTicket, createTicket, setStageCurrent } from '../store/tickets.js';
import type { StageKey } from '../model/types.js';
import { pickSubtasksToStart } from './subtaskAutostart.js';

let store: Store;
let projectId: number;
let n = 0;

function ticket(opts: {
  stage?: StageKey;
  parent?: number;
  queued?: boolean;
  blocking?: boolean;
  project?: number;
}): number {
  n += 1;
  const t = createTicket(store, {
    key: `P-${n}`,
    title: `t${n}`,
    projectId: opts.project ?? projectId,
    subtaskParentId: opts.parent,
    blocksParent: opts.blocking,
    autostartPending: opts.queued,
  });
  if (opts.stage) setStageCurrent(store, t.id, opts.stage);
  return t.id;
}

const caps = { perParent: 2, total: 4 };

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  n = 0;
});

describe('pickSubtasksToStart', () => {
  it('admits up to the per-parent cap', () => {
    const p = ticket({ stage: 'impl' });
    const a = ticket({ parent: p, queued: true });
    const b = ticket({ parent: p, queued: true });
    ticket({ parent: p, queued: true });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([a, b]);
  });

  it('counts running children against the per-parent cap and frees the slot at ship', () => {
    const p = ticket({ stage: 'impl' });
    const running = ticket({ parent: p, stage: 'review' });
    ticket({ parent: p, stage: 'fix' });
    const q = ticket({ parent: p, queued: true });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
    setStageCurrent(store, running, 'ship');
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([q]);
  });

  it('applies the project-wide cap across parents', () => {
    const p1 = ticket({ stage: 'impl' });
    const p2 = ticket({ stage: 'fix' });
    const p3 = ticket({ stage: 'uat' });
    ticket({ parent: p1, stage: 'impl' });
    ticket({ parent: p1, stage: 'impl' });
    const a = ticket({ parent: p2, queued: true });
    const b = ticket({ parent: p3, queued: true });
    ticket({ parent: p2, queued: true });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([a, b]);
  });

  it('counts nested (grandchild) slots toward the total cap', () => {
    const p = ticket({ stage: 'impl' });
    const c1 = ticket({ parent: p, stage: 'impl' });
    ticket({ parent: c1, stage: 'impl' });
    ticket({ parent: c1, stage: 'impl' });
    const c2 = ticket({ parent: p, stage: 'impl' });
    const q = ticket({ parent: c2, queued: true });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
    expect(pickSubtasksToStart(store, projectId, { perParent: 2, total: 5 })).toEqual([q]);
  });

  it('0 means unlimited for both caps', () => {
    const p = ticket({ stage: 'impl' });
    const ids = [1, 2, 3, 4, 5, 6].map(() => ticket({ parent: p, queued: true }));
    expect(pickSubtasksToStart(store, projectId, { perParent: 0, total: 0 })).toEqual(ids);
    expect(pickSubtasksToStart(store, projectId, { perParent: 0, total: 3 })).toHaveLength(3);
  });

  it('orders blocking children first, then by id', () => {
    const p = ticket({ stage: 'impl' });
    const plain = ticket({ parent: p, queued: true });
    const blocking = ticket({ parent: p, queued: true, blocking: true });
    expect(pickSubtasksToStart(store, projectId, { perParent: 1, total: 0 })).toEqual([blocking]);
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([blocking, plain]);
  });

  it('starts nothing while the parent is at scope, ship or done', () => {
    const p = ticket({ stage: 'scope' });
    ticket({ parent: p, queued: true });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
    for (const stage of ['ship', 'done'] as const) {
      setStageCurrent(store, p, stage);
      expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
    }
  });

  it('skips archived or detached children, non-scope children, and archived parents', () => {
    const p = ticket({ stage: 'impl' });
    const archived = ticket({ parent: p, queued: true });
    archiveTicket(store, archived);
    ticket({ queued: true }); // top-level, not a sub-task
    ticket({ parent: p, queued: true, stage: 'impl' }); // already past scope (holds a slot)
    const p2 = ticket({ stage: 'impl' });
    ticket({ parent: p2, queued: true });
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(p2);
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
  });

  it('ignores other projects', () => {
    const other = upsertProject(store, { slug: 'o' }).id;
    const p = ticket({ stage: 'impl', project: other });
    ticket({ parent: p, queued: true, project: other });
    expect(pickSubtasksToStart(store, projectId, caps)).toEqual([]);
  });

  it('restricts to owned parents when given', () => {
    const p1 = ticket({ stage: 'impl' });
    const p2 = ticket({ stage: 'impl' });
    ticket({ parent: p1, queued: true });
    const b = ticket({ parent: p2, queued: true });
    expect(pickSubtasksToStart(store, projectId, { ...caps, ownsParent: (id) => id === p2 })).toEqual([b]);
    expect(pickSubtasksToStart(store, projectId, { ...caps, ownsParent: () => false })).toEqual([]);
  });
});
