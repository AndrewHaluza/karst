import { describe, expect, it, vi } from 'vitest';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { assertRebuildSafe, SANDBOX_CLONE_EMPTY_REASON, waitForCloneReady } from './sbxCloneReady.js';
import { createSbxSessionRunner } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';
const input = { name: NAME, branch: 'feat/x' };
const SHA = 'a'.repeat(40);
const sleep = vi.fn(async () => undefined);

describe('waitForCloneReady', () => {
  it('is ready at once when the branch resolves', async () => {
    const proc = fakeSbxProcess();
    expect(await waitForCloneReady(proc, input, { sleep })).toEqual({ ok: true });
    expect(proc.calls).toHaveLength(1);
    expect(proc.calls[0]!.args).toContain('feat/x');
  });

  it('polls through a transient .invalid HEAD', async () => {
    let n = 0;
    const base = fakeSbxProcess();
    const proc = { ...base, run: (c: string, a: readonly string[], o?: never) => (++n < 3 ? Promise.resolve({ code: 74, stdout: '', stderr: '' }) : base.run(c, [...a], o)) };
    expect(await waitForCloneReady(proc, input, { sleep, timeoutMs: 10, intervalMs: 1 })).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it('blocks as empty after the bounded timeout', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { code: 74 } });
    sleep.mockClear();
    expect(await waitForCloneReady(proc, input, { sleep, timeoutMs: 3, intervalMs: 1 })).toEqual({ ok: false, reason: SANDBOX_CLONE_EMPTY_REASON });
    expect(proc.calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not block on an unrelated exec failure', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { code: 1, stderr: 'no such sandbox' } });
    expect(await waitForCloneReady(proc, input, { sleep })).toEqual({ ok: true });
  });
});

describe('assertRebuildSafe', () => {
  const git = (hits: Record<string, number>) => async (args: string[]) => ({ code: hits[args[0]!] ?? 0, stdout: '', stderr: '' });

  it('allows an empty sandbox (no refs, nothing to lose)', async () => {
    expect(await assertRebuildSafe(fakeSbxProcess(), input, git({}))).toEqual({ ok: true });
  });

  it('refuses when a sandbox commit is on neither host branch nor sync ref', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { stdout: `${SHA}\n` } });
    const r = await assertRebuildSafe(proc, input, git({ 'merge-base': 1 }));
    expect(r.ok).toBe(false);
  });

  it('allows a commit held by the sync ref only', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { stdout: `${SHA}\n` } });
    let calls = 0;
    const r = await assertRebuildSafe(proc, input, async (args) => ({ code: args[0] === 'merge-base' ? (calls++ === 0 ? 1 : 0) : 0, stdout: '', stderr: '' }));
    expect(r).toEqual({ ok: true });
  });

  it('refuses when the sandbox refs cannot be listed', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { code: 1, stderr: 'boom' } });
    expect((await assertRebuildSafe(proc, input, git({}))).ok).toBe(false);
  });
});

describe('runner.rebuild', () => {
  const ticket = { hostWorktreePath: '/wt/a', branch: 'feat/x' };
  it('removes the sandbox when safe', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME] });
    expect((await runner.rebuild!(ticket)).ok).toBe(true);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });
  it('keeps the sandbox when unsynced commits exist', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { stdout: `${SHA}\n` }, 'git -C /wt/a merge-base': { code: 1 } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME] });
    expect((await runner.rebuild!(ticket)).ok).toBe(false);
    expect(proc.calls.some((c) => c.args[0] === 'rm')).toBe(false);
  });
});
