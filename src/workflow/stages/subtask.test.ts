import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import {
  archiveTicket,
  createTicket,
  deleteTicket,
  setStageCurrent,
  TicketHasOpenSubtasksError,
  updateTicketFields,
  type ProjectScope,
} from '../../store/tickets.js';
import { getEnvOverrides, setServiceEnvOverrides } from '../../store/ticketEnvOverrides.js';
import {
  createSubtask,
  MAX_SUBTASK_DEPTH,
  SubtaskDepthExceededError,
  SubtaskParentArchivedError,
  SubtaskParentMissingError,
  SubtaskParentStageError,
  SubtaskProjectMismatchError,
  SubtaskRepoNotInParentError,
} from './subtask.js';

describe('createSubtask', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function parentTicket(
    overrides: {
      key?: string;
      title?: string;
      approach?: string;
      agent?: string;
      selectedRepos?: string[];
      model?: string;
      effort?: string;
      agentProvider?: string;
      agentPreset?: string;
      type?: string;
      projectId?: number;
      stage?: 'scope' | 'impl' | 'uat' | 'review' | 'fix' | 'ship' | 'done';
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
      effort: overrides.effort,
      agentProvider: overrides.agentProvider,
      agentPreset: overrides.agentPreset,
      type: overrides.type,
    });
    if (overrides.stage && overrides.stage !== 'scope') {
      setStageCurrent(store, t.id, overrides.stage);
    }
    return t.id;
  }

  it('creates a sub-task linked via subtaskParentId with a -s1 key', () => {
    const parent = parentTicket();
    const child = createSubtask(store, parent, {
      title: 'add API',
      description: 'the new ask',
    });
    expect(child.subtaskParentId).toBe(parent);
    // A sub-task is NOT a follow-up: the two relations are orthogonal.
    expect(child.parentTicketId).toBeNull();
    expect(child.key).toBe('PROJ-1-s1');
    expect(child.title).toBe('add API');
    expect(child.description).toBe('the new ask');
    expect(child.source).toBe('karst');
    expect(child.stageCurrent).toBe('scope');
    expect(child.blocksParent).toBe(false);
  });

  it('records a blocking sub-task as blocks_parent = 1', () => {
    const parent = parentTicket();
    const child = createSubtask(store, parent, { title: 'blocker', blocking: true });
    expect(child.blocksParent).toBe(true);
  });

  it('copies approach/agent/model/effort/provider/preset/type/repos/env, but not base_refs', () => {
    const parent = parentTicket({
      approach: 'rpi',
      agent: 'reviewer',
      selectedRepos: ['frontend', 'backend'],
      model: 'claude-opus-4-8',
      effort: 'high',
      agentProvider: 'codex',
      agentPreset: 'fast',
      type: 'fix',
    });
    updateTicketFields(store, parent, { baseRefs: { frontend: 'develop' } });
    setServiceEnvOverrides(store, parent, '*', { TOKEN: 'abc' });
    setServiceEnvOverrides(store, parent, 'frontend', { PORT: '3000' });

    const child = createSubtask(store, parent, { title: 'sub', repos: ['frontend'] });
    expect(child.approach).toBe('rpi');
    expect(child.agent).toBe('reviewer');
    expect(child.model).toBe('claude-opus-4-8');
    expect(child.effort).toBe('high');
    expect(child.agentProvider).toBe('codex');
    expect(child.agentPreset).toBe('fast');
    expect(child.type).toBe('fix');
    expect(child.selectedRepos).toEqual(['frontend']);
    expect(getEnvOverrides(store, child.id)).toEqual({
      '*': { TOKEN: 'abc' },
      frontend: { PORT: '3000' },
    });
    // The base is derived from the parent's branch, never inherited as an override.
    expect(child.baseRefs).toEqual({});
    // The parent's own overrides are untouched.
    expect(getEnvOverrides(store, parent)).toEqual({
      '*': { TOKEN: 'abc' },
      frontend: { PORT: '3000' },
    });
  });

  it('defaults repos to the parent repos when none are given', () => {
    const parent = parentTicket({ selectedRepos: ['frontend', 'backend'] });
    const child = createSubtask(store, parent, { title: 'sub' });
    expect(child.selectedRepos).toEqual(['frontend', 'backend']);
  });

  it('generates the next free -sN suffix per parent', () => {
    const parent = parentTicket();
    createSubtask(store, parent, { title: 'one' });
    const second = createSubtask(store, parent, { title: 'two' });
    expect(second.key).toBe('PROJ-1-s2');
  });

  it('nests keys: a sub-task of a sub-task is <parentKey>-s1-s1', () => {
    const parent = parentTicket();
    const first = createSubtask(store, parent, { title: 'one' });
    const nested = createSubtask(store, first.id, { title: 'two' });
    expect(nested.key).toBe('PROJ-1-s1-s1');
    expect(nested.subtaskParentId).toBe(first.id);
  });

  it(`allows exactly ${MAX_SUBTASK_DEPTH} levels of nesting and refuses the next`, () => {
    let current = parentTicket();
    for (let depth = 1; depth <= MAX_SUBTASK_DEPTH; depth += 1) {
      const child = createSubtask(store, current, { title: `level ${depth}` });
      expect(child.key).toBe(`PROJ-1${'-s1'.repeat(depth)}`);
      current = child.id;
    }
    expect(() => createSubtask(store, current, { title: 'too deep' })).toThrow(
      SubtaskDepthExceededError,
    );
  });

  it('refuses a repo the parent does not touch, naming it', () => {
    const parent = parentTicket({ selectedRepos: ['frontend'] });
    let caught: unknown;
    try {
      createSubtask(store, parent, { title: 'sub', repos: ['frontend', 'backend'] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubtaskRepoNotInParentError);
    expect((caught as SubtaskRepoNotInParentError).repos).toEqual(['backend']);
    expect((caught as Error).message).toContain('backend');
  });

  it('refuses a parent in ship or done (a done parent takes follow-ups)', () => {
    const shipping = parentTicket({ key: 'PROJ-2', stage: 'ship' });
    expect(() => createSubtask(store, shipping, { title: 'sub' })).toThrow(
      SubtaskParentStageError,
    );
    const done = parentTicket({ key: 'PROJ-3', stage: 'done' });
    expect(() => createSubtask(store, done, { title: 'sub' })).toThrow(SubtaskParentStageError);
  });

  it('refuses an archived parent', () => {
    const parent = parentTicket();
    archiveTicket(store, parent);
    expect(() => createSubtask(store, parent, { title: 'sub' })).toThrow(
      SubtaskParentArchivedError,
    );
  });

  it('refuses a missing parent', () => {
    expect(() => createSubtask(store, 9999, { title: 'sub' })).toThrow(SubtaskParentMissingError);
  });

  it('refuses a parent in a different project than the scope', () => {
    const parent = parentTicket({ projectId: 1 });
    expect(() => createSubtask(store, parent, { title: 'sub' }, { projectId: 2 })).toThrow(
      SubtaskProjectMismatchError,
    );
  });

  it('scopes key generation and the child project to the parent', () => {
    const parent = parentTicket({ projectId: 1 });
    const child = createSubtask(store, parent, { title: 'sub' }, { projectId: 1 });
    expect(child.projectId).toBe(1);
    expect(child.key).toBe('PROJ-1-s1');
  });

  it('detects a corrupt sub-task parent cycle instead of hanging', () => {
    const a = createTicket(store, { key: 'A-1', title: 'a' });
    const b = createTicket(store, { key: 'B-1', title: 'b' });
    store.db.prepare('UPDATE tickets SET subtask_parent_id = ? WHERE id = ?').run(b.id, a.id);
    store.db.prepare('UPDATE tickets SET subtask_parent_id = ? WHERE id = ?').run(a.id, b.id);
    expect(() => createSubtask(store, a.id, { title: 'sub' })).toThrow(/cycle/);
  });

  it('refuses to archive a parent with open sub-tasks, naming them', () => {
    const parent = parentTicket();
    createSubtask(store, parent, { title: 'one' });
    createSubtask(store, parent, { title: 'two' });
    let caught: unknown;
    try {
      archiveTicket(store, parent);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TicketHasOpenSubtasksError);
    expect((caught as TicketHasOpenSubtasksError).subtaskKeys).toEqual([
      'PROJ-1-s1',
      'PROJ-1-s2',
    ]);
  });

  it('refuses to delete a parent with open sub-tasks', () => {
    const parent = parentTicket();
    createSubtask(store, parent, { title: 'one' });
    expect(() => deleteTicket(store, parent)).toThrow(TicketHasOpenSubtasksError);
  });

  it('archives a parent once every sub-task is archived (an abandoned sub-task unblocks it)', () => {
    const parent = parentTicket();
    const child = createSubtask(store, parent, { title: 'one' });
    archiveTicket(store, child.id);
    expect(() => archiveTicket(store, parent)).not.toThrow();
  });

  it('emits debug lines at entry, the refusal, and exit', () => {
    const parent = parentTicket();
    const lines: string[] = [];
    const child = createSubtask(store, parent, { title: 'sub' }, {}, (m) => lines.push(m));
    expect(child.key).toBe('PROJ-1-s1');
    expect(lines[0]).toMatch(/\[driver\] sub-task under #\d+: parent stage is 'scope'/);
    expect(lines).toContainEqual(
      expect.stringMatching(/\[driver\] sub-task under #\d+: creating child 'PROJ-1-s1'/),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/\[driver\] sub-task under #\d+: child #\d+ \('PROJ-1-s1'\) created/),
    );
  });

  it('emits a debug line naming a stage refusal', () => {
    const parent = parentTicket({ stage: 'ship' });
    const lines: string[] = [];
    expect(() => createSubtask(store, parent, { title: 'sub' }, {}, (m) => lines.push(m))).toThrow(
      SubtaskParentStageError,
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/\[driver\] sub-task under #\d+: parent in 'ship' — refusing/),
    );
  });
});
