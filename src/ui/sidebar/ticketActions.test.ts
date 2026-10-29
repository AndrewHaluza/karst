import { describe, expect, it } from 'vitest';
import { ticketActionFlags } from './ticketActions.js';

const base = { stageCurrent: 'impl', archivedAt: null, pausedAt: null, subtaskParentId: null, blocksParent: false, agentState: null };

describe('ticketActionFlags', () => {
  it('open ticket: closable, not reopenable, not detachable, not paused', () => {
    expect(ticketActionFlags(base, 0)).toEqual({ paused: false, canClose: true, canReopen: false, canDetach: false, reviewStalled: false });
  });
  it('reports paused from pausedAt', () => {
    expect(ticketActionFlags({ ...base, pausedAt: '2026-10-27T00:00:00Z' }, 0).paused).toBe(true);
  });
  it('closed ticket: reopenable, not closable', () => {
    expect(ticketActionFlags({ ...base, stageCurrent: 'closed' }, 0)).toMatchObject({ canClose: false, canReopen: true });
  });
  it('sub-task is detachable only with no open children, no running agent, not blocking its parent', () => {
    const sub = { ...base, subtaskParentId: 3 };
    expect(ticketActionFlags(sub, 0).canDetach).toBe(true);
    expect(ticketActionFlags(sub, 1).canDetach).toBe(false);
    expect(ticketActionFlags({ ...sub, agentState: 'running' }, 0).canDetach).toBe(false);
    expect(ticketActionFlags({ ...sub, blocksParent: true }, 0).canDetach).toBe(false);
  });
  it('archived ticket can neither close nor reopen', () => {
    const a = { ...base, archivedAt: '2026-10-27T00:00:00Z' };
    expect(ticketActionFlags(a, 0)).toMatchObject({ canClose: false, canReopen: false });
    expect(ticketActionFlags({ ...a, stageCurrent: 'closed' }, 0).canReopen).toBe(false);
  });
});
