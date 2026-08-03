import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketFields } from '../../store/tickets.js';
import { createFollowUpTicket, TicketNotDoneError } from './followUp.js';

describe('createFollowUpTicket', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function doneParent(
    overrides: {
      key?: string;
      title?: string;
      approach?: string;
      agent?: string;
      selectedRepos?: string[];
      model?: string;
      agentProvider?: string;
      projectId?: number;
    } = {},
  ): number {
    const t = createTicket(store, {
      key: overrides.key ?? 'PROJ-1',
      title: overrides.title ?? 'Ship the thing',
      projectId: overrides.projectId,
    });
    updateTicketFields(store, t.id, {
      approach: overrides.approach,
      agent: overrides.agent,
      selectedRepos: overrides.selectedRepos ?? ['frontend'],
      model: overrides.model,
      agentProvider: overrides.agentProvider,
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
    return t.id;
  }

  it('creates a child ticket linked to the parent via parentTicketId', () => {
    const parentId = doneParent();
    const child = createFollowUpTicket(store, parentId);
    expect(child.parentTicketId).toBe(parentId);
    expect(child.key).toBe('PROJ-1-fu1');
    expect(child.title).toBe('Follow-up: Ship the thing');
    expect(child.source).toBe('karst');
  });

  it('copies repos/approach/agent/model/agentProvider from the parent', () => {
    const parentId = doneParent({
      approach: 'rpi',
      agent: 'reviewer',
      selectedRepos: ['frontend', 'backend'],
      model: 'claude-opus-4-8',
      agentProvider: 'codex',
    });
    const child = createFollowUpTicket(store, parentId);
    expect(child.approach).toBe('rpi');
    expect(child.agent).toBe('reviewer');
    expect(child.selectedRepos).toEqual(['frontend', 'backend']);
    expect(child.model).toBe('claude-opus-4-8');
    expect(child.agentProvider).toBe('codex');
  });

  it('generates the next free -fuN suffix when the parent already has a follow-up', () => {
    const parentId = doneParent();
    createFollowUpTicket(store, parentId);
    const second = createFollowUpTicket(store, parentId);
    expect(second.key).toBe('PROJ-1-fu2');
  });

  it('rejects a parent ticket that has not reached done', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 'still working' });
    expect(() => createFollowUpTicket(store, t.id)).toThrow(TicketNotDoneError);
  });

  it('scopes key generation per project, like getTicketByKey', () => {
    const parentId = doneParent({ projectId: 1 });
    const child = createFollowUpTicket(store, parentId, { projectId: 1 });
    expect(child.projectId).toBe(1);
    expect(child.key).toBe('PROJ-1-fu1');
  });
});
