import { describe, it, expect } from 'vitest';
import { isFinishedStage } from './types.js';
import { subtaskProgress, canAddSubtask, canDetachSubtask } from './subtask.js';
import { isLiveBaselineDependent } from '../store/baselineRefs.js';
import { diffsTicketChoices } from '../ui/diffs/ticketChoices.js';
import { artifactPriority } from './artifacts.js';

describe('isFinishedStage: done and closed have no more work, nothing else does', () => {
  it.each([
    ['done', true],
    ['closed', true],
    ['ship', false],
    ['impl', false],
    [null, false],
    ['bogus', false],
  ])('%s -> %s', (stage, expected) => {
    expect(isFinishedStage(stage)).toBe(expected);
  });
});

describe('a closed ticket is finished at every no-more-work site', () => {
  it('counts as a completed sub-task in the parent progress', () => {
    expect(subtaskProgress([{ stageCurrent: 'closed' }, { stageCurrent: 'impl' }])).toEqual({
      done: 1,
      total: 2,
    });
  });

  it('cannot gain sub-tasks, like a done parent', () => {
    expect(canAddSubtask({ stageCurrent: 'closed', archivedAt: null })).toBe(false);
  });

  it('cannot be detached as a sub-task, like a done one', () => {
    expect(
      canDetachSubtask(
        { subtaskParentId: 1, blocksParent: false, stageCurrent: 'closed', agentState: null },
        0,
      ),
    ).toBe(false);
  });

  it('is not a live baseline dependent unless its service still runs', () => {
    const d = { archived: false, stageCurrent: 'closed', hasRunningService: false };
    expect(isLiveBaselineDependent(d as never)).toBe(false);
    expect(isLiveBaselineDependent({ ...d, hasRunningService: true } as never)).toBe(true);
  });

  it('is not offered as a diffs ticket choice', () => {
    const t = { id: 1, key: 'T', title: 't', stageCurrent: 'closed' };
    expect(diffsTicketChoices([t], null)).toEqual([]);
  });

  it('takes the done artifact priority ranking', () => {
    expect(artifactPriority('plan', 'closed')).toBe(artifactPriority('plan', 'done'));
  });
});
