import { describe, it, expect } from 'vitest';
import {
  computeDriftNote,
  computeDriftNotes,
  computeDriftNotesSync,
  parseCodePointerPaths,
  sharedBaseSha,
  type DriftContext,
} from './drift.js';

describe('parseCodePointerPaths', () => {
  it('returns [] for empty input', () => {
    expect(parseCodePointerPaths(null)).toEqual([]);
    expect(parseCodePointerPaths(undefined)).toEqual([]);
    expect(parseCodePointerPaths('')).toEqual([]);
  });
  it('extracts unique paths, stripping line numbers', () => {
    expect(parseCodePointerPaths('- src/a.ts — entry\n- src/b.ts:42 — helper\n- src/a.ts — dup\nnot a pointer')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});

describe('sharedBaseSha', () => {
  const repos = [{ name: 'fe', repoPath: '/repos/fe' }] as never;
  it('maps a worktree repoPath to the manifest-name base sha', () => {
    expect(sharedBaseSha({ repos, baseShas: { fe: 'abc' } }, '/repos/fe')).toBe('abc');
  });
  it('returns undefined when no repo matches', () => {
    expect(sharedBaseSha({ repos, baseShas: { fe: 'abc' } }, '/other')).toBeUndefined();
    expect(sharedBaseSha({ repos, baseShas: {} }, '/repos/fe')).toBeUndefined();
  });
});

describe('computeDriftNote (sync, the CLI path)', () => {
  const sha = '1122334455667788';
  it('reports moved count and touching commits', () => {
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'log') return 'aa first\nbb second\n';
      return args.includes('--') ? '2\n' : '7\n';
    };
    expect(computeDriftNote('/wt', sha, 'develop', ['src/a.ts'], undefined, git)).toBe(
      'Planned against 11223344; develop has moved 7 commits since; 2 touch files this ticket names: aa first, bb second',
    );
    expect(calls[0]).toEqual(['rev-list', '--count', `${sha}..develop`]);
    expect(calls[2]).toEqual(['log', '-n', '5', '--format=%h %s', `${sha}..develop`, '--', 'src/a.ts']);
  });
  it('singular commit, no pointers, HEAD fallback', () => {
    expect(computeDriftNote('/wt', sha, null, [], undefined, () => '1\n')).toBe(
      'Planned against 11223344; HEAD has moved 1 commit since',
    );
  });
  it('returns only the prefix when no pointer-touching commits', () => {
    const git = (args: string[]) => (args.includes('--') ? '0\n' : '3\n');
    expect(computeDriftNote('/wt', sha, 'main', ['x'], undefined, git)).toBe(
      'Planned against 11223344; main has moved 3 commits since',
    );
  });
  it('is undefined for missing sha or zero/NaN count', () => {
    expect(computeDriftNote('/wt', undefined, 'main', [], undefined, () => '5')).toBeUndefined();
    expect(computeDriftNote('/wt', '  ', 'main', [], undefined, () => '5')).toBeUndefined();
    expect(computeDriftNote('/wt', sha, 'main', [], undefined, () => '0')).toBeUndefined();
    expect(computeDriftNote('/wt', sha, 'main', [], undefined, () => 'x')).toBeUndefined();
  });
  it('logs and returns undefined when git throws', () => {
    const logs: string[] = [];
    const git = () => {
      throw new Error('bad revision');
    };
    expect(computeDriftNote('/wt', sha, 'main', [], (m) => logs.push(m), git)).toBeUndefined();
    expect(logs[0]).toContain('[context:drift] git failed for /wt: bad revision');
  });
});

const ctxOf = (over: Partial<DriftContext> = {}): DriftContext => ({
  worktrees: [
    { repo: '/repos/fe', path: '/wt', branch: 'feat/x', baseRef: 'develop', depsMode: 'inherited' },
  ],
  baseShas: { fe: '1122334455667788' },
  repos: [{ name: 'fe', repoPath: '/repos/fe', runnable: false, unknown: false }],
  codePointers: null,
  ...over,
});

describe('computeDriftNotes (async, the host path)', () => {
  it('awaits the async runner and keys notes by worktree path', async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'log') return 'aa first\nbb second\n';
      return args.includes('--') ? '2\n' : '7\n';
    };
    const notes = await computeDriftNotes(
      ctxOf({ codePointers: '- src/a.ts — entry\n- src/b.ts:42 — helper' }),
      git,
    );
    expect(notes.get('/wt')).toBe(
      'Planned against 11223344; develop has moved 7 commits since; 2 touch files this ticket names: aa first, bb second',
    );
    expect(calls[0]).toEqual(['rev-list', '--count', '1122334455667788..develop']);
    expect(calls[1]).toEqual(['rev-list', '--count', '1122334455667788..develop', '--', 'src/a.ts', 'src/b.ts']);
    expect(calls[2]).toEqual(['log', '-n', '5', '--format=%h %s', '1122334455667788..develop', '--', 'src/a.ts', 'src/b.ts']);
  });

  it('omits a worktree with no base sha without calling git', async () => {
    let called = false;
    const notes = await computeDriftNotes(ctxOf({ baseShas: {} }), async () => {
      called = true;
      return '1\n';
    });
    expect(notes.size).toBe(0);
    expect(called).toBe(false);
  });

  it('never throws and omits the note when the async git runner rejects', async () => {
    const logs: string[] = [];
    const notes = await computeDriftNotes(
      ctxOf(),
      async () => {
        throw new Error('bad revision');
      },
      (m) => logs.push(m),
    );
    expect(notes.size).toBe(0);
    expect(logs[0]).toContain('[context:drift] git failed for /wt: bad revision');
  });

  it('resolves the base sha through the manifest name when the worktree repo is a path', async () => {
    const notes = await computeDriftNotes(
      ctxOf(),
      async (args) => (args[0] === 'log' ? '' : args.includes('--') ? '0\n' : '2\n'),
    );
    expect(notes.get('/wt')).toBe('Planned against 11223344; develop has moved 2 commits since');
  });
});

describe('computeDriftNotesSync (short-lived CLI)', () => {
  it('builds the same map from a synchronous runner', () => {
    const notes = computeDriftNotesSync(
      ctxOf({ codePointers: '- src/a.ts — entry' }),
      (args) => (args[0] === 'log' ? 'cc latest\n' : args.includes('--') ? '1\n' : '4\n'),
    );
    expect(notes.get('/wt')).toBe(
      'Planned against 11223344; develop has moved 4 commits since; 1 touch files this ticket names: cc latest',
    );
  });

  it('omits every worktree when none has a base sha', () => {
    expect(computeDriftNotesSync(ctxOf({ baseShas: {} }), () => '1\n').size).toBe(0);
  });
});
