import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../store/tickets.js';
import { parseSubtaskCreateArgs, runSubtaskCommand } from './subtaskCommand.js';

describe('parseSubtaskCreateArgs', () => {
  it('parses title, description, blocking and repos', () => {
    expect(
      parseSubtaskCreateArgs([
        'subtask',
        'create',
        '--title',
        'Carve this out',
        '--description',
        'Do the piece',
        '--blocking',
        '--repos',
        'frontend, backend',
      ]),
    ).toEqual({
      title: 'Carve this out',
      description: 'Do the piece',
      blocking: true,
      repos: ['frontend', 'backend'],
      start: true,
    });
  });

  it('parses --no-start as start false', () => {
    expect(
      parseSubtaskCreateArgs(['subtask', 'create', '--title', 'x', '--no-start']).start,
    ).toBe(false);
  });

  it('defaults blocking off and repos absent', () => {
    expect(parseSubtaskCreateArgs(['subtask', 'create', '--title', 'Only a title'])).toEqual({
      title: 'Only a title',
      description: undefined,
      blocking: false,
      repos: undefined,
      start: true,
    });
  });

  it('rejects a missing title, empty title, or wrong subcommand', () => {
    expect(() => parseSubtaskCreateArgs(['subtask', 'create', '--blocking'])).toThrow(/--title/);
    expect(() => parseSubtaskCreateArgs(['subtask', 'create', '--title', '   '])).toThrow(/--title/);
    expect(() => parseSubtaskCreateArgs(['subtask', 'destroy', '--title', 'x'])).toThrow(/create/);
    expect(() => parseSubtaskCreateArgs(['stage', 'create', '--title', 'x'])).toThrow(/subtask/);
  });

  it('rejects a flag without its value and an unknown flag', () => {
    expect(() => parseSubtaskCreateArgs(['subtask', 'create', '--title'])).toThrow(/--title/);
    expect(() => parseSubtaskCreateArgs(['subtask', 'create', '--title', 'x', '--nope'])).toThrow(
      /unknown flag/,
    );
    expect(() => parseSubtaskCreateArgs(['subtask', 'create', '--title', 'x', '--repos', ''])).toThrow(
      /--repos/,
    );
  });
});

describe('runSubtaskCommand', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function parent(): number {
    const t = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
    updateTicketFields(store, t.id, { selectedRepos: ['frontend', 'backend'], approach: 'rpi' });
    return t.id;
  }

  it('creates a sub-task of the given parent and returns its key as JSON', () => {
    const id = parent();
    const out = JSON.parse(
      runSubtaskCommand(store, id, [
        'subtask',
        'create',
        '--title',
        'Carve this out',
        '--description',
        'Do the piece',
        '--blocking',
        '--repos',
        'frontend',
      ]),
    );

    expect(out).toMatchObject({
      ok: true,
      key: 'PROJ-1-s1',
      title: 'Carve this out',
      parent: 'PROJ-1',
      blocking: true,
      repos: ['frontend'],
      stage: 'scope',
    });
    const child = getTicket(store, out.id);
    expect(child.description).toBe('Do the piece');
    expect(child.subtaskParentId).toBe(id);
    expect(child.approach).toBe('rpi');
  });

  it('defaults repos to all of the parent and blocking to false', () => {
    const id = parent();
    const out = JSON.parse(runSubtaskCommand(store, id, ['subtask', 'create', '--title', 'Piece']));
    expect(out.repos).toEqual(['frontend', 'backend']);
    expect(out.blocking).toBe(false);
    expect(out.autostart).toBe(true);
    expect(getTicket(store, out.id).autostartPending).toBe(true);
  });

  it('--no-start leaves the sub-task unqueued and reports autostart false', () => {
    const id = parent();
    const out = JSON.parse(
      runSubtaskCommand(store, id, ['subtask', 'create', '--title', 'Piece', '--no-start']),
    );
    expect(out.autostart).toBe(false);
    expect(getTicket(store, out.id).autostartPending).toBe(false);
  });

  it('refuses a repo the parent does not have', () => {
    const id = parent();
    expect(() =>
      runSubtaskCommand(store, id, [
        'subtask',
        'create',
        '--title',
        'Piece',
        '--repos',
        'frontend,other',
      ]),
    ).toThrow(/not in parent|other/);
  });

  it('refuses when the parent is at ship or done', () => {
    const id = parent();
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(id);
    expect(() => runSubtaskCommand(store, id, ['subtask', 'create', '--title', 'Piece'])).toThrow(
      /done/,
    );
  });

  it('throws when the resolved parent row is gone', () => {
    expect(() => runSubtaskCommand(store, 999, ['subtask', 'create', '--title', 'Piece'])).toThrow(
      /999/,
    );
  });
});
