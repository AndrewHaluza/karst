import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import { readTicketDiff, STALL_STAT_MAX_CHARS } from './stallDiff.js';

const tree = { repo: '/r', path: '/w', baseRef: 'develop' };
const res = (stdout: string, exitCode = 0) => Promise.resolve({ stdout, stderr: '', exitCode });

function fake(over: Partial<Record<string, string | number>> = {}): GitRunner {
  return (args) => {
    const key = args[0] === 'diff' ? args[1]! : args[0]!;
    const v = over[key];
    if (typeof v === 'number') return res('', v);
    if (key === 'merge-base') return res(v ?? 'abc\n');
    if (key === '--name-only') return res(v ?? 'docs/a.md\ndocs/b.md\n');
    if (key === '--stat') return res(v ?? ' docs/a.md | 2 +-\n');
    return res('', 1);
  };
}

describe('readTicketDiff', () => {
  it('returns the files and the stat', async () => {
    expect(await readTicketDiff(fake(), [tree])).toEqual({ files: ['docs/a.md', 'docs/b.md'], stat: ' docs/a.md | 2 +-' });
  });
  it('is null with no worktree, no base, or a failed git read', async () => {
    expect(await readTicketDiff(fake(), [])).toBeNull();
    expect(await readTicketDiff(fake(), [{ ...tree, baseRef: null }])).toBeNull();
    expect(await readTicketDiff(fake({ '--name-only': 128 }), [tree])).toBeNull();
    expect(await readTicketDiff(fake({ '--stat': 128 }), [tree])).toBeNull();
    expect(await readTicketDiff(fake({ 'merge-base': 1 }), [tree])).toBeNull();
  });
  it('joins several worktrees and cuts a long stat', async () => {
    const d = await readTicketDiff(fake({ '--stat': 'x'.repeat(STALL_STAT_MAX_CHARS + 50) }), [tree, tree]);
    expect(d!.files).toHaveLength(4);
    expect(d!.stat.endsWith('…')).toBe(true);
  });
});
