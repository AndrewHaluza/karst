import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { GitRunner } from '../../integrations/git.js';
import type { BaselineDecision } from '../../store/baselineDecisions.js';
import {
  baselineState,
  detectBaselineChanges,
  DELETED_SHA,
  toPathspecs,
  unapprovedBaselines,
  type BaselineEntry,
} from './baselineReview.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function fakeGit(opts: { remote?: boolean; diff?: string; mergeBaseExit?: number }): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') {
      return { stdout: '', stderr: '', exitCode: opts.remote === false ? 1 : 0 };
    }
    if (args[0] === 'merge-base') {
      const exitCode = opts.mergeBaseExit ?? 0;
      return { stdout: exitCode === 0 ? 'abc123\n' : '', stderr: 'no common ancestor', exitCode };
    }
    return { stdout: opts.diff ?? '', stderr: '', exitCode: 0 };
  };
  return { git, calls };
}

const REPO = { repo: '/r', cwd: '/wt', baseRef: 'develop' };
const files: Record<string, string> = { '/wt/a.png': 'new-a', '/wt/b.png': 'new-b' };
const readFile = async (abs: string): Promise<Buffer> => Buffer.from(files[abs] ?? '');

describe('detectBaselineChanges', () => {
  it('is off — and spawns nothing — with no globs', async () => {
    const { git, calls } = fakeGit({});
    expect(await detectBaselineChanges({ git, readFile }, [REPO], [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('classifies added, modified and deleted against the merge-base', async () => {
    const { git, calls } = fakeGit({ diff: 'A\0b.png\0M\0a.png\0D\0gone.png\0' });
    const entries = await detectBaselineChanges({ git, readFile }, [REPO], ['tests/**']);
    expect(entries).toEqual([
      { repo: '/r', cwd: '/wt', path: 'a.png', status: 'modified', newSha256: sha('new-a'), mergeBase: 'abc123' },
      { repo: '/r', cwd: '/wt', path: 'b.png', status: 'added', newSha256: sha('new-b'), mergeBase: 'abc123' },
      { repo: '/r', cwd: '/wt', path: 'gone.png', status: 'deleted', newSha256: DELETED_SHA, mergeBase: 'abc123' },
    ]);
    expect(calls.find((c) => c[0] === 'merge-base')).toEqual(['merge-base', 'origin/develop', 'HEAD']);
    expect(calls.find((c) => c[0] === 'diff')).toEqual([
      'diff', '--no-renames', '--name-status', '-z', 'abc123', 'HEAD', '--', ':(glob)tests/**',
    ]);
  });

  it('falls back to the local base branch when origin has none', async () => {
    const { git, calls } = fakeGit({ remote: false });
    await detectBaselineChanges({ git, readFile }, [REPO], ['x']);
    expect(calls.find((c) => c[0] === 'merge-base')).toEqual(['merge-base', 'develop', 'HEAD']);
  });

  it('throws — never reads as "unchanged" — when the merge-base is unknown', async () => {
    const { git } = fakeGit({ mergeBaseExit: 1 });
    await expect(detectBaselineChanges({ git, readFile }, [REPO], ['x'])).rejects.toThrow(/merge-base/);
  });

  it('prefixes every glob as a :(glob) pathspec', () => {
    expect(toPathspecs(['a/**', 'b.json'])).toEqual([':(glob)a/**', ':(glob)b.json']);
  });
});

describe('baseline approval', () => {
  const entry = (newSha256: string): BaselineEntry => ({
    repo: '/r', cwd: '/wt', path: 'a.png', status: 'modified', newSha256, mergeBase: 'abc',
  });
  const latest = (d: Partial<BaselineDecision>): Map<string, BaselineDecision> =>
    new Map([['/r\0a.png', { sha256: 's1', decision: 'approved', reason: null, decidedAt: 't', ...d }]]);

  it('is pending with no decision', () => {
    expect(baselineState(entry('s1'), new Map())).toEqual({ kind: 'pending' });
  });

  it('is approved while the sha still matches', () => {
    expect(baselineState(entry('s1'), latest({}))).toEqual({ kind: 'approved' });
  });

  it('lapses to pending when the agent changes the file again', () => {
    expect(baselineState(entry('s2'), latest({}))).toEqual({ kind: 'pending' });
  });

  it('carries the reason of a rejection on the same sha', () => {
    expect(baselineState(entry('s1'), latest({ decision: 'rejected', reason: 'blurry' }))).toEqual({
      kind: 'rejected', reason: 'blurry',
    });
  });

  it('keeps rejected entries blocking, approved ones not', () => {
    const entries = [entry('s1')];
    expect(unapprovedBaselines(entries, latest({}))).toEqual([]);
    expect(unapprovedBaselines(entries, latest({ decision: 'rejected', reason: 'x' }))).toEqual(entries);
  });
});
