import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, setStageCurrent } from './tickets.js';
import { listLandedStackedSubtasks } from './subtasks.js';

let store: Store;
let parentId: number;

function landedChild(key: string, baseRef: string): number {
  const id = createTicket(store, { key, title: key, projectId: 1, subtaskParentId: parentId }).id;
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(id, '/r', `/w/${key}`, `karst/${key}`, baseRef);
  setStageCurrent(store, id, 'done');
  return id;
}

beforeEach(() => {
  store = openStore(':memory:');
  parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId: 1 }).id;
});

describe('listLandedStackedSubtasks', () => {
  it('returns a landed child cut from the parent branch', () => {
    const id = landedChild('P-1-s1', 'karst/P-1');
    expect(listLandedStackedSubtasks(store, parentId, '/r', 'karst/P-1').map((c) => c.id)).toEqual([id]);
  });

  it('does not return a landed non-stacked child (base is another branch)', () => {
    landedChild('P-1-s2', 'develop');
    expect(listLandedStackedSubtasks(store, parentId, '/r', 'karst/P-1')).toEqual([]);
  });
});
