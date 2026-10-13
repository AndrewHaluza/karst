import { describe, expect, it, vi } from 'vitest';
import { HOST_SESSION_RUNNER } from '../sessionRunner.js';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { autonomousPermissionArgs, createSbxSessionRunner, sandboxRemote } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';
const spec = (args: string[] = []) => ({
  ticketId: 7,
  hostWorktreePath: '/wt/with space',
  command: 'claude',
  args,
  env: { KARST_TICKET: '7' },
});
const ticket = { hostWorktreePath: '/wt/a', branch: 'feat/x' };

describe('createSbxSessionRunner.placeInteractive', () => {
  it('creates a fresh claude sandbox in clone mode, path as one element', () => {
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [] });
    expect(runner.kind).toBe('sbx');
    expect(runner.enforcesSandbox).toBe(true);
    const placed = runner.placeInteractive(spec(['--model', 'opus', '--resume', 'abc']));
    expect(placed).toEqual({
      cwd: '/wt/with space',
      shellPath: 'sbx',
      shellArgs: [
        'run', '--clone', '--name', NAME, 'claude', '/wt/with space',
        '--', '--dangerously-skip-permissions', '--model', 'opus', '--resume', 'abc',
      ],
      env: { KARST_TICKET: '7' },
    });
    expect(placed.shellArgs).not.toContain('--mount-docker-socket');
  });

  it('creates a fresh codex sandbox with its effort args after --', () => {
    const name = 'karst-ab12cd34-7-codex';
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name, existing: [] });
    expect(runner.placeInteractive(spec(['--config', 'model_reasoning_effort=high'])).shellArgs).toEqual([
      'run', '--clone', '--name', name, 'codex', '/wt/with space',
      '--', '--dangerously-bypass-approvals-and-sandbox', '--config', 'model_reasoning_effort=high',
    ]);
  });

  it('reattaches by name only when sbx ls reported the sandbox', () => {
    const reattach = ['run', '--name', NAME, 'claude', '--', '--dangerously-skip-permissions'];
    const existing = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [NAME] });
    expect(existing.placeInteractive(spec()).shellArgs).toEqual(reattach);
  });

  it('keeps --clone on a retry when the first launch never created the sandbox', () => {
    const fresh = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: ['other'] });
    fresh.placeInteractive(spec());
    expect(fresh.placeInteractive(spec()).shellArgs).toEqual([
      'run', '--clone', '--name', NAME, 'claude', '/wt/with space', '--', '--dangerously-skip-permissions',
    ]);
  });
});

describe('createSbxSessionRunner.runHeadless', () => {
  it('runs via sbx exec and passes exit code and abort signal through', async () => {
    const result = { stdout: 'o', stderr: '', exitCode: 3 };
    const spawnHeadless = vi.fn().mockResolvedValue(result);
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name: NAME, existing: [], spawnHeadless });
    const signal = new AbortController().signal;
    await expect(runner.runHeadless('codex', ['exec', 'hi there'], '/wt/a', { signal })).resolves.toBe(result);
    expect(spawnHeadless).toHaveBeenCalledWith('sbx', ['exec', NAME, '--', 'codex', 'exec', 'hi there'], '/wt/a', { signal });
  });
});

describe('createSbxSessionRunner.sync', () => {
  const remote = sandboxRemote(NAME);

  it('fast-forwards the ticket branch from the sandbox remote', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    await expect(runner.sync!(ticket)).resolves.toEqual({ ok: true, summary: `fast-forwarded feat/x to ${remote}/feat/x` });
    expect(proc.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      `git -C /wt/a remote get-url ${remote}`,
      `git -C /wt/a fetch ${remote}`,
      `git -C /wt/a merge-base --is-ancestor HEAD ${remote}/feat/x`,
      `git -C /wt/a merge --ff-only ${remote}/feat/x`,
    ]);
  });

  it('refuses a non-fast-forward and never merges', async () => {
    const proc = fakeSbxProcess({ 'git -C /wt/a merge-base': { code: 1 } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    const out = await runner.sync!(ticket);
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/not a fast-forward.*never forced/) });
    expect(proc.calls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('reports a missing remote', async () => {
    const proc = fakeSbxProcess({ 'git -C /wt/a remote get-url': { code: 2 } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    await expect(runner.sync!(ticket)).resolves.toEqual({ ok: false, reason: expect.stringContaining(`no sandbox remote ${remote}`) });
    expect(proc.calls).toHaveLength(1);
  });

  it('reports fetch and merge failures', async () => {
    const fetchFail = fakeSbxProcess({ 'git -C /wt/a fetch': { code: 1, stderr: 'net down\n' } });
    await expect(createSbxSessionRunner({ proc: fetchFail, core: 'claude', name: NAME, existing: [] }).sync!(ticket))
      .resolves.toEqual({ ok: false, reason: `git fetch ${remote} failed: net down` });
    const mergeFail = fakeSbxProcess({ 'git -C /wt/a merge --ff-only': { code: 1, stderr: 'dirty\n' } });
    await expect(createSbxSessionRunner({ proc: mergeFail, core: 'claude', name: NAME, existing: [] }).sync!(ticket))
      .resolves.toEqual({ ok: false, reason: `git merge --ff-only ${remote}/feat/x failed: dirty` });
  });
});

describe('createSbxSessionRunner.dispose', () => {
  it('targets exactly its own name and leaves a bystander alone', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [NAME, 'bystander'] });
    await runner.dispose!(ticket);
    expect(proc.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      `sbx stop ${NAME}`,
      `sbx rm --force ${NAME}`,
      `git -C /wt/a remote remove ${sandboxRemote(NAME)}`,
    ]);
    expect(proc.calls.some((c) => c.args.includes('bystander'))).toBe(false);
    // Disposed: the next launch creates again.
    expect(runner.placeInteractive(spec()).shellArgs).toContain('--clone');
  });
});

describe('autonomousPermissionArgs (arch:AC-31 conformance)', () => {
  it.each(['claude', 'codex', 'opencode'])('never relaxes %s on the host runner', (core) => {
    expect(autonomousPermissionArgs(core, HOST_SESSION_RUNNER)).toEqual([]);
  });

  it('relaxes only claude/codex on an enforcing runner', () => {
    const sbx = { enforcesSandbox: true };
    expect(autonomousPermissionArgs('claude', sbx)).toEqual(['--dangerously-skip-permissions']);
    expect(autonomousPermissionArgs('codex', sbx)).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(autonomousPermissionArgs('opencode', sbx)).toEqual([]);
  });
});
