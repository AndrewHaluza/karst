import { describe, it, expect } from 'vitest';
import {
  SUBTASK_TEXT_MARKER,
  isSubtask,
  subtaskTextPrefix,
  compactSubtaskLabel,
  subtaskParentRef,
  subtaskProgress,
  canAddSubtask,
} from './subtask.js';
import { FOLLOW_UP_TEXT_MARKER } from './followUp.js';

describe('sub-task identity', () => {
  it('SUBTASK_TEXT_MARKER is exactly one character', () => {
    expect(SUBTASK_TEXT_MARKER).toBe('⊂');
    expect([...SUBTASK_TEXT_MARKER]).toHaveLength(1);
  });

  it('the marker is distinct from follow-up\'s so a text-only surface can tell them apart', () => {
    expect(SUBTASK_TEXT_MARKER).not.toBe(FOLLOW_UP_TEXT_MARKER);
  });

  it('isSubtask reads the subtaskParentId domain fact, never the title', () => {
    expect(isSubtask({ subtaskParentId: 12 })).toBe(true);
    expect(isSubtask({ subtaskParentId: null })).toBe(false);
  });

  it('subtaskTextPrefix renders the one-char marker with a trailing space, or nothing', () => {
    expect(subtaskTextPrefix({ subtaskParentId: 12 })).toBe('⊂ ');
    expect(subtaskTextPrefix({ subtaskParentId: null })).toBe('');
  });

  it('compactSubtaskLabel prefixes a rendered label for a sub-task only', () => {
    expect(compactSubtaskLabel({ subtaskParentId: 12 }, 'PROJ-1-s1 — add API')).toBe(
      '⊂ PROJ-1-s1 — add API',
    );
    expect(compactSubtaskLabel({ subtaskParentId: null }, 'PROJ-1 — ship it')).toBe(
      'PROJ-1 — ship it',
    );
  });

  it('subtaskParentRef renders the marker plus the parent key for a rich surface', () => {
    expect(subtaskParentRef('PROJ-1')).toBe('⊂ PROJ-1');
  });
});

describe('subtaskProgress', () => {
  it('counts how many sub-tasks reached the terminal done stage', () => {
    expect(subtaskProgress([])).toEqual({ done: 0, total: 0 });
    expect(
      subtaskProgress([
        { stageCurrent: 'done' },
        { stageCurrent: 'impl' },
        { stageCurrent: 'done' },
        { stageCurrent: null },
      ]),
    ).toEqual({ done: 2, total: 4 });
  });
});

describe('canAddSubtask', () => {
  it('allows a sub-task any time the parent is not shipping, done, or archived', () => {
    expect(canAddSubtask({ stageCurrent: 'impl', archivedAt: null })).toBe(true);
    expect(canAddSubtask({ stageCurrent: 'uat', archivedAt: null })).toBe(true);
    expect(canAddSubtask({ stageCurrent: null, archivedAt: null })).toBe(true);
  });

  it('refuses while the parent ships or is done, matching the writer', () => {
    expect(canAddSubtask({ stageCurrent: 'ship', archivedAt: null })).toBe(false);
    expect(canAddSubtask({ stageCurrent: 'done', archivedAt: null })).toBe(false);
  });

  it('refuses an archived parent', () => {
    expect(canAddSubtask({ stageCurrent: 'impl', archivedAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });
});
