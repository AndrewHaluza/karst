import { describe, it, expect } from 'vitest';
import {
  SUBTASK_TEXT_MARKER,
  isSubtask,
  subtaskTextPrefix,
  compactSubtaskLabel,
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
});
