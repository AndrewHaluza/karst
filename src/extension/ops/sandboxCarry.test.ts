import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carryCommits } from './sandboxCarry.js';
import type { GitRun } from './sandboxRewrite.js';

const R = 'a'.repeat(40); const C = 'b'.repeat(40);
type Reply = { code?: number; stdout?: string; stderr?: string };

function script(replies: Record<string, Reply>) {
  const calls: string[][] = [];
  const run: GitRun = async (_cwd, args) => {
    calls.push([...args]);
    const r = replies[args[0]!] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}
const input = () => ({ worktree: '/wt', recorded: R, cloneHead: C, scratch: mkdtempSync(join(tmpdir(), 'karst-cs-')) });

describe('carryCommits (scripted git)', () => {
  it('reports a failed status with its stderr', async () => {
    const s = script({ status: { code: 128, stderr: ' not a repo \n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: false, reason: 'failed', message: 'git status failed: not a repo' });
  });

  it('refuses a dirty worktree before counting anything', async () => {
    const s = script({ status: { stdout: ' M a.txt\n' } });
    expect(await carryCommits(s.run, input())).toMatchObject({ ok: false, reason: 'dirty' });
    expect(s.calls.map((c) => c[0])).toEqual(['status']);
  });

  it('reports a failed rev-list', async () => {
    const s = script({ 'rev-list': { code: 128, stderr: 'bad range\n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: false, reason: 'failed', message: 'git rev-list failed: bad range' });
  });

  it('an empty range carries nothing and applies nothing', async () => {
    const s = script({ 'rev-list': { stdout: '0\n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: true, carried: 0 });
    expect(s.calls.map((c) => c[0])).toEqual(['status', 'rev-list']);
  });

  it('reports a failed format-patch', async () => {
    const s = script({ 'rev-list': { stdout: '2\n' }, 'format-patch': { code: 1, stderr: 'boom\n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: false, reason: 'failed', message: 'git format-patch failed: boom' });
  });

  it('exports the exact range, applies it with am -3 from a temp file and removes the file', async () => {
    const i = input();
    let patch = '';
    const s = script({ 'rev-list': { stdout: '2\n' }, 'format-patch': { stdout: 'PATCH' } });
    const run: GitRun = async (cwd, args) => {
      if (args[0] === 'am') patch = readFileSync(args[2]!, 'utf8');
      return s.run(cwd, args);
    };
    expect(await carryCommits(run, i)).toEqual({ ok: true, carried: 2 });
    expect(s.calls[1]).toEqual(['rev-list', '--count', `${R}..${C}`]);
    expect(s.calls[2]).toEqual(['format-patch', '--stdout', '--binary', `${R}..${C}`]);
    expect(s.calls[3]!.slice(0, 2)).toEqual(['am', '-3']);
    expect(patch).toBe('PATCH');
    expect(readdirSync(i.scratch)).toEqual([]);
  });

  it('lists the conflicted paths when am stops, and does not abort', async () => {
    const s = script({ 'rev-list': { stdout: '1\n' }, am: { code: 1 }, diff: { stdout: 'a.txt\n b.txt \n\n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: false, reason: 'conflict', paths: ['a.txt', 'b.txt'] });
    expect(s.calls.map((c) => c[0])).not.toContain('abort');
    expect(s.calls.at(-1)).toEqual(['diff', '--name-only', '--diff-filter=U']);
  });

  it('an am failure with no unmerged paths is a plain failure carrying am output', async () => {
    const s = script({ 'rev-list': { stdout: '1\n' }, am: { code: 1, stderr: 'patch does not apply\n' } });
    expect(await carryCommits(s.run, input())).toEqual({ ok: false, reason: 'failed', message: 'git am failed: patch does not apply' });
    const t = script({ 'rev-list': { stdout: '1\n' }, am: { code: 1, stdout: 'from stdout\n' } });
    expect(await carryCommits(t.run, input())).toMatchObject({ message: 'git am failed: from stdout' });
  });

  it('cleans the scratch dir even when am fails', async () => {
    const i = input();
    const s = script({ 'rev-list': { stdout: '1\n' }, am: { code: 1 } });
    await carryCommits(s.run, i);
    expect(existsSync(i.scratch) && readdirSync(i.scratch)).toEqual([]);
  });
});
