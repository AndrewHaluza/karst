import { describe, expect, it } from 'vitest';

import { HOOK_EDIT_TOOLS, hookTrailers, locateHookEdit } from './hookEdit.js';

const targets = [
  { ticketId: 1, repoPath: '/r/a', worktreePath: '/w/a', baseRef: 'main' },
  { ticketId: 1, repoPath: '/r/b', worktreePath: '/w/b', baseRef: 'main' },
];

describe('locateHookEdit', () => {
  it('maps an absolute path inside a worktree to that target and relPath', () => {
    expect(locateHookEdit(targets, '/w/b', '/w/b/docs/plan.md')).toEqual({ target: targets[1], relPath: 'docs/plan.md' });
  });

  it('resolves a relative path against cwd', () => {
    expect(locateHookEdit(targets, '/w/a', 'docs/plan.md')).toEqual({ target: targets[0], relPath: 'docs/plan.md' });
  });

  it('finds a sibling worktree of the same ticket', () => {
    expect(locateHookEdit(targets, '/w/a', '/w/b/x.md')?.target).toBe(targets[1]);
  });

  it.each(['/etc/passwd', '/w/a/../../etc/passwd', '../outside.md', '/w/ab/x.md', '/w/a', ''])(
    'rejects %s',
    (p) => expect(locateHookEdit(targets, '/w/a', p)).toBeUndefined(),
  );
});

describe('hookTrailers', () => {
  it('marks the source agent-hook and keeps the run session', () => {
    expect(hookTrailers({ approach: 'g', kind: 'plan', source: 'watcher', session: '7' }, 'prov-1')).toEqual({
      approach: 'g', kind: 'plan', source: 'agent-hook', session: '7',
    });
  });

  it('falls back to the provider session id when no run is active', () => {
    expect(hookTrailers({ approach: 'g', kind: 'plan', source: 'manual-edit' }, 'prov-1').session).toBe('prov-1');
  });
});

describe('HOOK_EDIT_TOOLS', () => {
  it('covers Write, Edit and MultiEdit only', () => {
    expect([...HOOK_EDIT_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'Write']);
  });
});
