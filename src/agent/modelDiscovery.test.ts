import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  discoverAntigravityModels,
  discoverClaudeModels,
  discoverCodexModels,
  discoverOpencodeModels,
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

  it('reads the headingless id list the installed agy CLI actually prints', () => {
    expect(parseAntigravityModels([
      'gemini-3.6-flash-high',
      'claude-opus-4-6-thinking',
      '',
    ].join('\n'))).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high', providers: ['antigravity'] },
      { id: 'claude-opus-4-6-thinking', label: 'claude-opus-4-6-thinking', providers: ['antigravity'] },
    ]);
  });

  it.each([
    ['usage text', 'Usage: agy models [options]\n  --json  print JSON\n'],
    ['an error page', 'error: not logged in, run agy auth login\n'],
    ['nothing at all', '\n\n'],
  ])('refuses to read %s as a headingless model list', (_case, stdout) => {
    expect(parseAntigravityModels(stdout)).toBeUndefined();
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

  it('initializes Codex before requesting models and closes stdin only after response id 2', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnImpl;
    const discovery = discoverCodexModels(makeCommandRunner(spawnImpl, { timeoutMs: 100 }));

    const writesBeforeInitialize = child.stdin.write.mock.calls.map(([value]) => String(value));
    const endsBeforeInitialize = child.stdin.end.mock.calls.length;

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      id: 1,
      result: { serverInfo: { name: 'codex' } },
    })}\n`));
    const writesBeforeModelList = child.stdin.write.mock.calls.map(([value]) => String(value));
    const endsBeforeModelList = child.stdin.end.mock.calls.length;

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      id: 2,
      result: {
        data: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', availability: 'available' }],
      },
    })}\n`));
    const endsAfterModelList = child.stdin.end.mock.calls.length;
    child.emit('close', 0);

    await expect(discovery).resolves.toMatchObject({ status: 'available' });
    expect(writesBeforeInitialize).toEqual([
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'karst', version: '1.0.0' }, capabilities: {} },
      })}\n`,
    ]);
    expect(endsBeforeInitialize).toBe(0);
    expect(writesBeforeModelList).toEqual([
      writesBeforeInitialize[0],
      [
        JSON.stringify({ method: 'initialized', params: {} }),
        JSON.stringify({ id: 2, method: 'model/list', params: {} }),
        '',
      ].join('\n'),
    ]);
    expect(endsBeforeModelList).toBe(0);
    expect(endsAfterModelList).toBe(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('preserves a Codex model label split across UTF-8 stdout chunks', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnImpl;
    const discovery = discoverCodexModels(makeCommandRunner(spawnImpl, { timeoutMs: 100 }));

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 1, result: {} })}\n`));
    const response = Buffer.from(`${JSON.stringify({
      id: 2,
      result: {
        data: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sól', availability: 'available' }],
      },
    })}\n`);
    const multibyteStart = response.indexOf(Buffer.from('ó'));
    child.stdout.emit('data', response.subarray(0, multibyteStart + 1));
    child.stdout.emit('data', response.subarray(multibyteStart + 1));
    child.emit('close', 0);

    await expect(discovery).resolves.toEqual({
      status: 'available',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sól', providers: ['codex'] }],
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

  // The code, not the prose, is what the catalog loader classifies by: an absent
  // optional CLI is a normal state and a broken one is not, and the two must not
  // be told apart by grepping a human-readable sentence.
  it.each([
    ['an uninstalled CLI', 'command unavailable' as const, 'command-unavailable'],
    ['a hung CLI', 'timed out' as const, 'timeout'],
    ['a failing CLI', 'command failed' as const, 'nonzero-exit'],
    ['a flooding CLI', 'output exceeded' as const, 'invalid-output'],
  ])('codes %s distinctly', async (_case, failure, code) => {
    const run: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: 1, failure });
    await expect(discoverCodexModels(run)).resolves.toMatchObject({ status: 'unavailable', code });
    await expect(discoverAntigravityModels(run)).resolves.toMatchObject({ status: 'unavailable', code });
  });

  it('codes an unclassified non-zero exit as a non-zero exit, not a missing command', async () => {
    await expect(discoverCodexModels(completed('', 3, 'boom')))
      .resolves.toMatchObject({ status: 'unavailable', code: 'nonzero-exit' });
  });

  it('codes unparseable output as invalid output rather than an absent CLI', async () => {
    await expect(discoverCodexModels(completed('{not json}')))
      .resolves.toMatchObject({ status: 'unavailable', code: 'invalid-output' });
  });

  it('reports Claude CLI discovery as unsupported, never as a missing command', async () => {
    await expect(discoverClaudeModels()).resolves.toEqual({
      status: 'unavailable',
      code: 'unsupported',
      reason: 'Claude CLI model discovery is unsupported',
    });
  });

  it('reports opencode models as unsupported (account-dependent, not probed)', async () => {
    const result = await discoverOpencodeModels();
    expect(result).toEqual({ status: 'unavailable', code: 'unsupported', reason: expect.any(String) });
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

  it('retains no more decoded output than the combined raw-byte bound', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('éé')));
      return child;
    }) as unknown as SpawnImpl;

    const result = await makeCommandRunner(spawnImpl, { maxOutputBytes: 3 })('agy', ['models']);
    expect(result).toMatchObject({ exitCode: 1, failure: 'output exceeded', stdout: 'é' });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(3);
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

  it('uses a shell-free, piped process for non-interactive commands', async () => {
    const child = fakeChild();
    let options: unknown;
    const spawnImpl = vi.fn((_command: string, _args: readonly string[], receivedOptions: unknown) => {
      options = receivedOptions;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as SpawnImpl;

    const run = makeCommandRunner(spawnImpl);
    await run('agy', ['models']);

    expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});
