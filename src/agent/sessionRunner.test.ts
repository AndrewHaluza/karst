import { describe, it, expect, vi } from 'vitest';
import { HOST_SESSION_RUNNER, createHostSessionRunner } from './sessionRunner.js';

describe('HostSessionRunner', () => {
  it('declares itself host and not an enforced sandbox (arch:AC-31 fail closed)', () => {
    expect(HOST_SESSION_RUNNER.kind).toBe('host');
    expect(HOST_SESSION_RUNNER.enforcesSandbox).toBe(false);
  });

  it('places an interactive launch unchanged: argv, env, cwd identical', () => {
    const spec = {
      ticketId: 7,
      hostWorktreePath: '/wt/a',
      command: 'claude',
      args: ['--x', 'y'],
      env: { A: '1' },
    };
    const placed = HOST_SESSION_RUNNER.placeInteractive(spec);
    expect(placed).toEqual({ cwd: '/wt/a', shellPath: 'claude', shellArgs: ['--x', 'y'], env: { A: '1' } });
    expect(placed.shellArgs).not.toBe(spec.args);
    expect(placed.env).not.toBe(spec.env);
  });

  it('runs headless through the injected spawner with the same arguments', async () => {
    const result = { stdout: 'ok', stderr: '', code: 0 };
    const spawnHeadless = vi.fn().mockResolvedValue(result);
    const runner = createHostSessionRunner(spawnHeadless);
    const opts = { timeoutMs: 5 };
    await expect(runner.runHeadless('codex', ['exec'], '/wt/b', opts)).resolves.toBe(result);
    expect(spawnHeadless).toHaveBeenCalledWith('codex', ['exec'], '/wt/b', opts);
  });
});
