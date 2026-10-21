import { describe, expect, it, vi } from 'vitest';
import type { ProcessOutcome } from '../../workflow/gates/run.js';
import type { ProjectSandbox } from '../../agent/sandboxInventory.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';
import { ticketHostGate } from './sandboxHostGate.js';

const SHA = 'a'.repeat(40);
const ok = (output: string): ProcessOutcome => ({ kind: 'completed', exitCode: 0, output });
const box = (state: 'running' | 'stopped'): ProjectSandbox => ({ runner: 'docker', name: 'n', ticketId: 1, core: 'opencode', state });

function setup(opts: { sandboxFail?: boolean; hasSandbox?: boolean; statusFail?: boolean; listed?: ProjectSandbox; afterStart?: ProjectSandbox; startOutcome?: ProcessOutcome; sync?: EnsureSyncResult; hostHead?: string; sandboxHead?: string; status?: string } = {}) {
  const sync = vi.fn(() => Promise.resolve(opts.sync ?? { ok: true as const }));
  const git = vi.fn((_c: string, args: readonly string[], _d?: string, _o?: unknown) =>
    Promise.resolve(args[0] === 'status' ? (opts.statusFail ? ({ kind: 'completed', exitCode: 128, output: '' } as ProcessOutcome) : ok(opts.status ?? '')) : ok(opts.hostHead ?? SHA)));
  const sandboxGate = vi.fn((c: string, _a: readonly string[], _d: string, _o?: unknown) => Promise.resolve(c === 'true' && opts.startOutcome ? opts.startOutcome : opts.sandboxFail ? ({ kind: 'completed', exitCode: 1, output: SHA } as ProcessOutcome) : ok(opts.sandboxHead ?? SHA)));
  const debug = vi.fn();
  const sandbox = { backends: () => ({ opencode: 'docker' as const }), dockerProc: { run: () => Promise.resolve({ code: opts.hasSandbox ? 0 : 1, stdout: '', stderr: '' }) } as never, debug, projectRoot: () => '/p', coreOf: () => 'opencode', inventory: () => Promise.resolve(opts.listed ? [opts.afterStart && sandboxGate.mock.calls.length > 0 ? opts.afterStart : opts.listed] : []) };
  const factory = ticketHostGate({ sandbox, sync, git }, 1, sandboxGate);
  return { run: factory(), sync, git, sandboxGate, debug };
}

// The host-run command is real `runProcess`; `true`/`false` keep it portable and fast.
describe('ticketHostGate (arch:AC-36)', () => {
  it('syncs once, passes the dirty guard, then runs on the host', async () => {
    const t = setup({ listed: box('running') });
    const a = await t.run('true', [], process.cwd(), {});
    const b = await t.run('true', [], process.cwd(), {});
    expect(a.kind).toBe('completed');
    expect(b.kind).toBe('completed');
    expect(t.sync).toHaveBeenCalledTimes(1);
  });

  it('starts a stopped sandbox once, re-lists it running, then syncs and runs', async () => {
    const t = setup({ listed: box('stopped'), afterStart: box('running') });
    expect((await t.run('true', [], process.cwd(), {})).kind).toBe('completed');
    expect(t.sandboxGate.mock.calls.filter((c) => c[0] === 'true')).toHaveLength(1);
    expect(t.sync).toHaveBeenCalledTimes(1);
    expect(t.debug).toHaveBeenCalledWith('[gate] ticket 1: sandbox stopped, started for host gates');
  });

  it('refuses when the start fails, no sync', async () => {
    const t = setup({ listed: box('stopped'), startOutcome: { kind: 'completed', exitCode: 1, output: 'boom' } });
    const out = await t.run('true', [], process.cwd(), {});
    expect(out).toMatchObject({ kind: 'spawnFailed', message: 'sandbox could not be started: boom' });
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('refuses when the sandbox is still stopped after the start', async () => {
    const t = setup({ listed: box('stopped') });
    const out = await t.run('true', [], process.cwd(), {});
    expect(out).toMatchObject({ kind: 'spawnFailed' });
    expect((out as { message: string }).message).toContain('sandbox could not be started');
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('runs on the host with no sync or guard when the sandbox is gone', async () => {
    const t = setup();
    expect((await t.run('true', [], process.cwd(), {})).kind).toBe('completed');
    expect(t.sync).not.toHaveBeenCalled();
    expect(t.git).not.toHaveBeenCalled();
  });

  it('refuses on a failed sync with the reason', async () => {
    const t = setup({ listed: box('running'), sync: { ok: false, reason: 'not a fast-forward', diverged: true } });
    const out = await t.run('true', [], process.cwd(), {});
    expect(out).toMatchObject({ kind: 'spawnFailed' });
    expect((out as { message: string }).message).toContain('not a fast-forward');
  });

  it('refuses on a HEAD mismatch', async () => {
    const t = setup({ listed: box('running'), sandboxHead: 'b'.repeat(40) });
    expect(await t.run('true', [], process.cwd(), {})).toMatchObject({ kind: 'spawnFailed' });
  });

  it('refuses on an unreadable HEAD', async () => {
    const t = setup({ listed: box('running'), sandboxHead: 'garbage' });
    expect(await t.run('true', [], process.cwd(), {})).toMatchObject({ kind: 'spawnFailed' });
  });

  it('refuses a dirty host worktree', async () => {
    const t = setup({ listed: box('running'), status: ' M a.ts\n' });
    const out = await t.run('true', [], process.cwd(), {});
    expect((out as { message: string }).message).toContain('uncommitted');
  });

  it('logs why a gate ran on the host or was refused', async () => {
    const synced = setup({ listed: box('running') });
    await synced.run('true', [], process.cwd(), {});
    expect(synced.debug).toHaveBeenCalledWith(expect.stringContaining('after a verified sync'));
    const refused = setup({ listed: box('stopped') });
    await refused.run('true', [], process.cwd(), {});
    expect(refused.debug).toHaveBeenCalledWith(expect.stringContaining('host gate refused: sandbox could not be started'));
    const bare = setup();
    await bare.run('true', [], process.cwd(), {});
    expect(bare.debug).toHaveBeenCalledWith(expect.stringContaining('(no sandbox)'));
  });

  it('names HEAD, status and sync failures distinctly', async () => {
    const mismatch = await setup({ listed: box('running'), sandboxHead: 'b'.repeat(40) }).run('true', [], process.cwd(), {});
    expect((mismatch as { message: string }).message).toContain('aaaaaaaa differs from sandbox HEAD bbbbbbbb');
    const unreadable = await setup({ listed: box('running'), hostHead: 'x' }).run('true', [], process.cwd(), {});
    expect((unreadable as { message: string }).message).toContain('cannot read the host or sandbox HEAD');
    const status = await setup({ listed: box('running'), statusFail: true }).run('true', [], process.cwd(), {});
    expect((status as { message: string }).message).toContain('cannot read the host worktree status');
    const sync = await setup({ listed: box('running'), sync: { ok: false, reason: 'boom', diverged: false } }).run('true', [], process.cwd(), {});
    expect((sync as { message: string }).message).toBe('sandbox sync failed, host gates not run: boom');
  });

  it('treats an unlisted sandbox the runner still reports as attached', async () => {
    const t = setup({ hasSandbox: true });
    await t.run('true', [], process.cwd(), {});
    expect(t.sync).toHaveBeenCalledTimes(1);
  });

  it('reads HEAD and status with exact git argv in the worktree', async () => {
    const t = setup({ listed: box('running') });
    await t.run('true', [], '/wt', {});
    expect(t.git.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['git', ['rev-parse', 'HEAD'], '/wt'],
      ['git', ['status', '--porcelain'], '/wt'],
    ]);
    expect(t.sandboxGate.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['git', ['rev-parse', 'HEAD'], '/wt']]);
  });

  it('tolerates noise around a HEAD, but not a failing rev-parse or whitespace-only status', async () => {
    expect((await setup({ listed: box('running'), hostHead: `warn\n${SHA}\n`, sandboxHead: ` ${SHA}\n` }).run('true', [], process.cwd(), {})).kind).toBe('completed');
    expect((await setup({ listed: box('running'), status: '  \n' }).run('true', [], process.cwd(), {})).kind).toBe('completed');
    expect((await setup({ listed: box('running'), sandboxFail: true }).run('true', [], process.cwd(), {})).kind).toBe('spawnFailed');
  });

  it('a runner without hasSandbox, and no listing, is not attached', async () => {
    const t = setup();
    expect((await t.run('true', [], process.cwd(), {})).kind).toBe('completed');
    expect(t.sync).not.toHaveBeenCalled();
  });
});
