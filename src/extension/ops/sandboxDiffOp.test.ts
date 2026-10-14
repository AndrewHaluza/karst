import { describe, expect, it, vi } from 'vitest';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { diffSandboxOp } from './sandboxDiffOp.js';

const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

function setup(proc = fakeSbxProcess({ 'git -C /wt/a diff': { stdout: 'diff --git a/f b/f\n+x\n' } })) {
  const errors: string[] = [];
  const infos: string[] = [];
  const showDiff = vi.fn(async () => {});
  const deps = {
    notify: { info: (m: string) => infos.push(m), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
    projectRoot: '/p', proc, showDiff,
  };
  return { deps, errors, infos, showDiff, proc };
}

describe('diffSandboxOp', () => {
  it('shows the sandbox diff and merges nothing', async () => {
    const { deps, showDiff, proc, errors } = setup();
    await expect(diffSandboxOp(deps, target)).resolves.toBe(true);
    expect(showDiff).toHaveBeenCalledWith(expect.stringContaining('K-7'), 'diff --git a/f b/f\n+x\n');
    expect(proc.calls.some((c) => c.args.includes('merge'))).toBe(false);
    expect(errors).toEqual([]);
  });

  it('says so instead of opening an empty editor when there is nothing to bring in', async () => {
    const { deps, showDiff, infos } = setup(fakeSbxProcess());
    await expect(diffSandboxOp(deps, target)).resolves.toBe(true);
    expect(showDiff).not.toHaveBeenCalled();
    expect(infos).toEqual(['Karst: the sandbox of K-7 has no commits beyond the host branch.']);
  });

  it('reports a failed diff', async () => {
    const { deps, showDiff, errors } = setup(fakeSbxProcess({ 'git -C /wt/a fetch': { code: 1, stderr: 'net down\n' } }));
    await expect(diffSandboxOp(deps, target)).resolves.toBe(false);
    expect(showDiff).not.toHaveBeenCalled();
    expect(errors).toEqual([expect.stringMatching(/^Karst: sandbox diff for K-7 failed: git fetch .* failed: net down/)]);
  });

  it('refuses a ticket without a worktree branch or without a sandbox core, running nothing', async () => {
    const a = setup();
    await expect(diffSandboxOp(a.deps, { ...target, worktree: undefined })).resolves.toBe(false);
    expect(a.errors).toEqual(['Karst: K-7 has no worktree branch to diff against.']);
    const b = setup();
    await expect(diffSandboxOp(b.deps, { ...target, core: 'antigravity' })).resolves.toBe(false);
    expect(b.errors).toEqual(['Karst: K-7 has no sandbox (core antigravity).']);
    expect(a.proc.calls.length + b.proc.calls.length).toBe(0);
  });
});
