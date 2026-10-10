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

function fakeGit(opts: {
  remote?: boolean;
  diff?: string;
  untracked?: string;
  mergeBaseExit?: number;
  base?: Record<string, string>;
}): { git: GitRunner; calls: string[][] } {
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
    if (args[0] === 'show') {
      const text = opts.base?.[args[1]!.split(':')[1]!];
      return text === undefined
        ? { stdout: '', stderr: 'missing', exitCode: 128 }
        : { stdout: text, stderr: '', exitCode: 0 };
    }
    if (args[0] === 'ls-files') return { stdout: opts.untracked ?? '', stderr: '', exitCode: 0 };
    return { stdout: opts.diff ?? '', stderr: '', exitCode: 0 };
  };
  return { git, calls };
}

const REPO = { repo: '/r', cwd: '/wt', baseRef: 'develop' };
const files: Record<string, string> = {
  '/wt/a.png': 'new-a', '/wt/b.png': 'new-b', '/wt/u.png': 'new-u',
  '/wt/ledger.json': '["x"]', '/wt/grow.json': '["x","y"]',
};
const readFile = async (abs: string): Promise<Buffer> => Buffer.from(files[abs] ?? '');

describe('detectBaselineChanges (working tree)', () => {
  it('is off — and spawns nothing — with no globs', async () => {
    const { git, calls } = fakeGit({});
    expect(await detectBaselineChanges({ git, readFile }, [REPO], [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('classifies modified, added, untracked and deleted against the merge-base, hashing the working-tree file', async () => {
    const { git, calls } = fakeGit({ diff: 'A\0b.png\0M\0a.png\0D\0gone.png\0', untracked: 'u.png\0' });
    const entries = await detectBaselineChanges({ git, readFile }, [REPO], ['tests/**']);
    const base = { repo: '/r', cwd: '/wt', mergeBase: 'abc123', autoApproved: false };
    expect(entries).toEqual([
      { ...base, path: 'a.png', status: 'modified', newSha256: sha('new-a') },
      { ...base, path: 'b.png', status: 'added', newSha256: sha('new-b') },
      { ...base, path: 'gone.png', status: 'deleted', newSha256: DELETED_SHA },
      { ...base, path: 'u.png', status: 'added', newSha256: sha('new-u') },
    ]);
    expect(calls.find((c) => c[0] === 'merge-base')).toEqual(['merge-base', 'origin/develop', 'HEAD']);
    expect(calls.find((c) => c[0] === 'diff')).toEqual([
      'diff', '--no-renames', '--name-status', '-z', 'abc123', '--', ':(glob)tests/**',
    ]);
    expect(calls.find((c) => c[0] === 'ls-files')).toEqual([
      'ls-files', '--others', '--exclude-standard', '-z', '--', ':(glob)tests/**',
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

  describe('ledger shrink is auto-approved', () => {
    const run = async (diff: string, base: Record<string, string>) =>
      detectBaselineChanges({ git: fakeGit({ diff, base }).git, readFile }, [REPO], ['*.json']);

    it('a json array that only drops entries', async () => {
      const [e] = await run('M\0ledger.json\0', { 'ledger.json': '["x","y"]' });
      expect(e!.autoApproved).toBe(true);
    });
    it('a deleted json file', async () => {
      const [e] = await run('D\0ledger.json\0', {});
      expect(e!.autoApproved).toBe(true);
    });
    it('NOT a json array that gains an entry', async () => {
      const [e] = await run('M\0grow.json\0', { 'grow.json': '["x"]' });
      expect(e!.autoApproved).toBe(false);
    });
    it('NOT an image deletion', async () => {
      const [e] = await run('D\0a.png\0', {});
      expect(e!.autoApproved).toBe(false);
    });
    it('NOT an unreadable base', async () => {
      const [e] = await run('M\0ledger.json\0', {});
      expect(e!.autoApproved).toBe(false);
    });
  });
});

describe('baseline approval', () => {
  const entry = (newSha256: string): BaselineEntry => ({
    repo: '/r', cwd: '/wt', path: 'a.png', status: 'modified', newSha256, mergeBase: 'abc', autoApproved: false,
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

  it('counts an auto-approved ledger shrink as approved with no decision', () => {
    expect(baselineState({ ...entry('s1'), autoApproved: true }, new Map())).toEqual({ kind: 'approved' });
  });

  it('keeps rejected entries blocking, approved ones not', () => {
    const entries = [entry('s1')];
    expect(unapprovedBaselines(entries, latest({}))).toEqual([]);
    expect(unapprovedBaselines(entries, latest({ decision: 'rejected', reason: 'x' }))).toEqual(entries);
  });
});
