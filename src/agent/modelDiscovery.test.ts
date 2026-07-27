import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  discoverAntigravityModels,
  discoverClaudeModels,
  discoverCodexModels,
  makeCommandRunner,
  parseAntigravityModels,
  type CommandRunner,
  type SpawnImpl,
} from './modelDiscovery.js';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.kill = vi.fn();
  return child;
}

function completed(stdout: string, exitCode = 0, stderr = ''): CommandRunner {
  return async () => ({ stdout, stderr, exitCode });
}

describe('parseAntigravityModels', () => {
  it('derives stable IDs while preserving model labels', () => {
    expect(parseAntigravityModels([
      'Available models:',
      '  Gemini 3.6 Flash (High)',
      '  Claude Opus 5 (Thinking)',
    ].join('\n'))).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', providers: ['antigravity'] },
      { id: 'claude-opus-5-thinking', label: 'Claude Opus 5 (Thinking)', providers: ['antigravity'] },
    ]);
  });
});

describe('provider discovery', () => {
  it('reads only Codex model/list response id 2 after unrelated JSON-lines notifications', async () => {
    const result = await discoverCodexModels(completed([
      JSON.stringify({ method: 'account/updated', params: { plan: 'pro' } }),
      JSON.stringify({ id: 1, result: { serverInfo: { name: 'codex' } } }),
      JSON.stringify({ id: 2, result: { data: [
        { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', availability: 'available' },
        { model: 'gpt-5.6-pro', displayName: 'GPT-5.6 Pro', availability: 'unavailable' },
      ] } }),
    ].join('\n')));

    expect(result).toEqual({
      status: 'available',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'] }],
    });
  });

  it.each([
    ['a non-zero exit', completed('', 1, 'not installed')],
    ['a malformed Codex protocol response', completed('{not json}')],
    ['an empty Codex model list', completed(JSON.stringify({ id: 2, result: { data: [] } }))],
  ])('reports %s as unavailable', async (_case, run) => {
    await expect(discoverCodexModels(run)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports an empty Antigravity list as unavailable', async () => {
    await expect(discoverAntigravityModels(completed('Available models:\n')))
      .resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports Claude CLI discovery as explicitly unsupported', async () => {
    await expect(discoverClaudeModels()).resolves.toEqual({
      status: 'unavailable',
      reason: 'Claude CLI model discovery is unsupported',
    });
  });
});

describe('makeCommandRunner', () => {
  it('reports a missing command without rejecting', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
      return child;
    }) as unknown as SpawnImpl;

    const result = await makeCommandRunner(spawnImpl)('missing', []);
    expect(result).toMatchObject({ exitCode: 1, failure: 'command unavailable' });
  });

  it('kills and reports a timed-out child', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnImpl;

    const result = await makeCommandRunner(spawnImpl, { timeoutMs: 1 })('codex', ['app-server']);
    expect(result).toMatchObject({ exitCode: 1, failure: 'timed out' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills when combined stdout and stderr exceed the output bound', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('12345')));
      return child;
    }) as unknown as SpawnImpl;

    const result = await makeCommandRunner(spawnImpl, { maxOutputBytes: 4 })('agy', ['models']);
    expect(result).toMatchObject({ exitCode: 1, failure: 'output exceeded' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('turns an asynchronous stdin EPIPE into an isolated command failure', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      });
      return child;
    }) as unknown as SpawnImpl;

    const result = await makeCommandRunner(spawnImpl)('codex', ['app-server'], '{"id":1}\n');
    expect(result).toMatchObject({ exitCode: 1, failure: 'command failed' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('uses a shell-free, piped process and sends Codex protocol input', async () => {
    const child = fakeChild();
    let options: unknown;
    const spawnImpl = vi.fn((_command: string, _args: readonly string[], receivedOptions: unknown) => {
      options = receivedOptions;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as SpawnImpl;

    const run = makeCommandRunner(spawnImpl);
    await run('codex', ['app-server', '--stdio'], '{"id":2}\n');

    expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin.write).toHaveBeenCalledWith('{"id":2}\n');
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});
