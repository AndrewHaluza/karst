import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, setStageCurrent } from './tickets.js';
import { setStage } from './stages.js';
import { clearStageBlock, parkGateStage } from './stageBlocks.js';
import { listInbox } from './ticketMessages.js';
import { transition } from '../workflow/machine.js';
import { openWritableStore } from '../cli/writableStore.js';

/**
 * Sub-task events are written AT THE SOURCE — inside the single stage writer —
 * so a CLI `karst stage … pass` and a host transition emit alike.
 */
describe('sub-task events from the stage writer', () => {
  let store: Store;
  let projectId: number;
  let parentId: number;
  let childId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId }).id;
    childId = createTicket(store, {
      key: 'P-1-s1',
      title: 'child',
      projectId,
      subtaskParentId: parentId,
    }).id;
  });
  afterEach(() => store.close());

  const inbox = (id: number) => listInbox(store, id, { unreadOnly: false });

  it('writes one landed event to the parent when a sub-task enters done', () => {
    setStageCurrent(store, childId, 'ship');
    transition(store, childId, 'ship', { kind: 'passed' });
    const rows = inbox(parentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      fromTicketId: null,
      toTicketId: parentId,
      kind: 'event',
      body: 'P-1-s1 landed (done)',
    });
  });

  it('does not repeat the landed event when done is re-patched passed', () => {
    setStage(store, childId, 'done', { status: 'passed' });
    setStage(store, childId, 'done', { status: 'passed', verdict: null });
    expect(inbox(parentId)).toHaveLength(1);
  });

  it('writes nothing for a non-sub-task entering done', () => {
    setStage(store, parentId, 'done', { status: 'passed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ticket_messages').get()).toEqual({ n: 0 });
  });

  it('writes nothing for other stages passing', () => {
    setStage(store, childId, 'impl', { status: 'passed' });
    expect(inbox(parentId)).toEqual([]);
  });

  it('writes one blocked event with the stage and a bounded reason', () => {
    const reason = 'r'.repeat(500);
    parkGateStage(store, {
      ticketId: childId,
      stageKey: 'uat',
      kind: 'boot-failed',
      reason,
      runAt: '2026-01-01T00:00:00Z',
      gates: [],
    });
    const rows = inbox(parentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('event');
    expect(rows[0]!.body).toBe(`P-1-s1 blocked at uat: ${'r'.repeat(300)}`);
  });

  it('does not repeat while the same block stands, and re-emits after a clear', () => {
    const park = () =>
      setStage(store, childId, 'uat', {
        blockedKind: 'boot-failed',
        blockedReason: 'server died',
        blockedAt: 'x',
      });
    park();
    park();
    expect(inbox(parentId)).toHaveLength(1);
    clearStageBlock(store, childId, 'uat');
    expect(inbox(parentId)).toHaveLength(1);
    park();
    expect(inbox(parentId).map((m) => m.body)).toEqual([
      'P-1-s1 blocked at uat: server died',
      'P-1-s1 blocked at uat: server died',
    ]);
  });

  it('writes nothing when a non-sub-task is blocked', () => {
    setStage(store, parentId, 'uat', { blockedKind: 'boot-failed', blockedReason: 'x' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ticket_messages').get()).toEqual({ n: 0 });
  });

  it('never fails the stage write when the parent row is gone (no FK on subtask_parent_id)', () => {
    store.db.prepare('UPDATE tickets SET subtask_parent_id = 9999 WHERE id = ?').run(childId);
    expect(() => setStage(store, childId, 'done', { status: 'passed' })).not.toThrow();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ticket_messages').get()).toEqual({ n: 0 });
  });

  it('files the event unscoped when the child names a project row that does not exist', () => {
    store.db.prepare('UPDATE tickets SET project_id = 9999 WHERE id = ?').run(childId);
    setStage(store, childId, 'done', { status: 'passed' });
    expect(inbox(parentId)[0]!.projectId).toBeNull();
  });

  it('falls back to #id when the sub-task has no key', () => {
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(childId);
    setStage(store, childId, 'done', { status: 'passed' });
    expect(inbox(parentId)[0]!.body).toBe(`#${childId} landed (done)`);
  });

  it('rolls the event back with the stage write when the enclosing transaction fails', () => {
    const tx = store.db.transaction(() => {
      setStage(store, childId, 'done', { status: 'passed' });
      throw new Error('boom');
    });
    expect(() => tx()).toThrow('boom');
    expect(inbox(parentId)).toEqual([]);
  });
});

describe('sub-task events through the CLI node:sqlite store', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('emits exactly one landed event inside the machine transaction', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-ev-'));
    const path = join(dir, 'karst.db');
    const host = openStore(path);
    const projectId = upsertProject(host, { slug: 'p' }).id;
    const parentId = createTicket(host, { key: 'P-1', title: 'p', projectId }).id;
    const childId = createTicket(host, {
      key: 'P-1-s1',
      title: 'c',
      projectId,
      subtaskParentId: parentId,
    }).id;
    setStageCurrent(host, childId, 'ship');
    host.close();

    const cli = openWritableStore(path);
    try {
      transition(cli, childId, 'ship', { kind: 'passed' });
      setStage(cli, childId, 'uat', { blockedKind: 'boot-failed', blockedReason: 'down' });
    } finally {
      cli.close();
    }

    const check = openStore(path);
    try {
      expect(listInbox(check, parentId, { unreadOnly: false }).map((m) => m.body)).toEqual([
        'P-1-s1 landed (done)',
        'P-1-s1 blocked at uat: down',
      ]);
    } finally {
      check.close();
    }
  });
});
