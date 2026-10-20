import { describe, expect, it, vi } from 'vitest';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import { carrySandboxOp } from './sandboxCarryOp.js';

const target = { ticketId: 7, ticketLabel: 'K-7', core: 'claude', worktree: { path: '/wt/a', branch: 'feat/x' } };

function setup(over: { fetch?: { ok: boolean; reason?: string }; owns?: boolean; runner?: boolean } = {}) {
  const errors: string[] = [];
  const infos: string[] = [];
  const reopen = vi.fn(async () => {});
  const remove = vi.fn(async () => true);
  const fetchClone = vi.fn(async () => (over.fetch ?? { ok: true }) as { ok: true });
  const runner = (over.runner === false ? {} : { fetchClone }) as SessionRunner;
  const deps = {
    notify: { info: (m: string) => infos.push(m), warn: vi.fn(), error: (m: string) => { errors.push(m); return Promise.resolve(); } },
    projectRoot: '/p', choose: vi.fn(), owns: () => over.owns ?? true, openSyncDiff: vi.fn(), reopen, remove, runner,
  };
  return { deps, errors, infos, reopen, remove, fetchClone };
}

describe('carrySandboxOp refusals (nothing removed, nothing reopened)', () => {
  it.each([
    ['no worktree branch', { worktree: undefined }, {}, 'no worktree branch.'],
    ['another window', {}, { owns: false }, 'belongs to another window'],
    ['no sandbox runner', {}, { runner: false }, 'no sandbox (core claude)'],
    ['a failed fetch', {}, { fetch: { ok: false, reason: 'no sandbox clone to sync from: gone' } }, 'no sandbox clone to sync from: gone'],
  ])('%s', async (_n, t, o, text) => {
    const s = setup(o);
    await expect(carrySandboxOp(s.deps, { ...target, ...t })).resolves.toBe(false);
    expect(s.errors).toEqual([expect.stringContaining(text)]);
    expect(s.remove).not.toHaveBeenCalled();
    expect(s.reopen).not.toHaveBeenCalled();
  });
});
