import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CodexAdapter,
  parseCodexJsonl,
  resolveNodeExecutable,
  type SpawnHeadless,
} from './codex.js';
import { writeCurrentEndpoint, readCurrentEndpoint, currentEndpointPath } from './hookFailureLog.js';

const okJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-7' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'agent_message', text: 'first' },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i2', type: 'agent_message', text: 'final' },
  }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');

function fakeSpawn(
  result: { stdout: string; stderr?: string; exitCode: number },
): SpawnHeadless {
  return async () => ({
    stdout: result.stdout,
    stderr: result.stderr ?? '',
    exitCode: result.exitCode,
  });
}

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-codex-worktree-'));
  temporaryRoots.push(root);
  return root;
}

function materializeBridge(configDir: string): string {
  new CodexAdapter().buildInteractiveCommand({
    cwd: makeWorktree(),
    hookChannel: {
      endpointUrl: 'http://127.0.0.1:4567/hooks',
      configDir,
    },
  });
  return join(configDir, 'codex', 'bridge.cjs');
}

function runBridge(
  bridgePath: string,
  endpointUrl: string | undefined,
  diagnosticsPath: string,
  input: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [bridgePath, endpointUrl ?? '', diagnosticsPath];
    const child = spawn(resolveNodeExecutable(), args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
    child.stdin.end(input);
  });
}

function receiveOneHook(
  respond: 'success' | 'reject' | 'abort' = 'success',
): Promise<{
  endpointUrl: string;
  received: Promise<unknown>;
  /** The request URLs as the server saw them, in arrival order. */
  urls: string[];
  close(): Promise<void>;
}> {
  let resolveBody!: (body: unknown) => void;
  const received = new Promise<unknown>((resolve) => {
    resolveBody = resolve;
  });
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? '');
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      resolveBody(JSON.parse(body));
      if (respond === 'abort') {
        response.writeHead(200, { 'content-length': '10' });
        response.write('x');
        response.socket?.destroy();
      } else {
        response.writeHead(respond === 'reject' ? 400 : 204);
        response.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('hook receiver did not bind a TCP port'));
        return;
      }
      resolve({
        endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
        received,
        urls,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });
  });
}

/** A receiver that collects `count` sequential POSTs, in arrival order. */
function receiveHooks(
  count: number,
): Promise<{
  endpointUrl: string;
  received: Promise<unknown[]>;
  close(): Promise<void>;
}> {
  const bodies: unknown[] = [];
  let resolveAll!: (bodies: unknown[]) => void;
  const received = new Promise<unknown[]>((resolve) => {
    resolveAll = resolve;
  });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      if (bodies.length >= count) resolveAll(bodies);
      response.writeHead(204);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('hook receiver did not bind a TCP port'));
        return;
      }
      resolve({
        endpointUrl: `http://127.0.0.1:${address.port}/hooks`,
        received,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });
  });
}

function makeBasePackage(
  id: string,
  files: readonly (readonly [string, string])[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-codex-package-'));
  temporaryRoots.push(root);
  for (const [relativePath, body] of files) {
    const path = join(root, id, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

describe('CodexAdapter interactive commands', () => {
  it('declares truthful capabilities and binary', () => {
    const adapter = new CodexAdapter();
    expect(adapter.requiredBinary).toBe('codex');
    expect(adapter.capabilities).toEqual({
      lifecycleEvents: true,
      resume: true,
      interactiveUsage: true,
    });
  });

  it('builds a fresh interactive launch', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'custom-model',
      extraArgs: ['--no-alt-screen'],
      initialPrompt: '- inspect\ncarefully',
    });
    expect(cmd).toEqual({
      command: 'codex',
      args: [
        '--model',
        'custom-model',
        '--no-alt-screen',
        '--',
        '- inspect\ncarefully',
      ],
      env: {},
    });
  });

  it('builds a resumed interactive launch', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: '/wt',
      resume: '0199-thread',
      model: 'custom-model',
      initialPrompt: 'continue',
    });
    expect(cmd).toEqual({
      command: 'codex',
      args: ['resume', '--model', 'custom-model', '0199-thread', 'continue'],
      env: {},
    });
  });

  it('threads an effort as --config model_reasoning_effort=<value>', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'custom-model',
      effort: 'high',
      initialPrompt: 'go',
    });
    expect(cmd).toEqual({
      command: 'codex',
      args: ['--model', 'custom-model', '--config', 'model_reasoning_effort=high', '--', 'go'],
      env: {},
    });
  });

  it('materializes Codex command hooks and passes the project config layer', () => {
    const worktree = makeWorktree();
    const configDir = makeWorktree();
    const hooksPath = join(worktree, '.codex', 'hooks.json');
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, '{"user":"owned"}');

    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: worktree,
      hookChannel: {
        endpointUrl: 'http://127.0.0.1:4567/hooks',
        configDir,
      },
      initialPrompt: 'go',
    });

    const bridgePath = join(configDir, 'codex', 'bridge.cjs');
    expect(readFileSync(hooksPath, 'utf8')).toBe('{"user":"owned"}');
    expect(readFileSync(bridgePath, 'utf8')).toContain('permission_prompt');
    expect(existsSync(join(worktree, '.codex', 'karst'))).toBe(false);
    expect(cmd.ownedPaths).toBeUndefined();
    expect(cmd.args).toContain('--dangerously-bypass-hook-trust');
    expect(cmd.args).not.toContain('--add-dir');
    const overrides = cmd.args.filter(
      (_arg, index) => cmd.args[index - 1] === '-c',
    );
    expect(overrides).toHaveLength(7);
    expect(overrides[0]).toBe('hooks={}');
    expect(
      overrides.some((value) => value.startsWith('hooks.SessionStart=')),
    ).toBe(true);
    expect(
      overrides.some((value) => value.startsWith('hooks.PermissionRequest=')),
    ).toBe(true);
  });

  it('runs hook bridges with the standalone Node resolved from PATH', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: makeWorktree(),
      hookChannel: {
        endpointUrl: 'http://127.0.0.1:4567/hooks',
        configDir: makeWorktree(),
      },
    });

    const sessionStart = cmd.args.find((value) =>
      value.startsWith('hooks.SessionStart='),
    );
    // Assert on the DECODED command, not the TOML source text. The command is
    // JSON-quoted into the TOML value, so on Windows every separator in the node
    // path arrives doubled (`C:\\Program Files\\...`) — matching raw text here
    // only ever worked because a mac path has no backslashes to escape.
    const quoted = /command = ("(?:[^"\\]|\\.)*")/.exec(sessionStart ?? '')?.[1];
    expect(quoted).toBeDefined();
    const command = JSON.parse(quoted!) as string;
    expect(command.startsWith(`${JSON.stringify(resolveNodeExecutable())} `)).toBe(true);
  });

  it('does not replace the shared bridge when another terminal session launches', () => {
    const configDir = makeWorktree();
    const adapter = new CodexAdapter();
    const opts = {
      cwd: makeWorktree(),
      hookChannel: {
        endpointUrl: 'http://127.0.0.1:4567/hooks',
        configDir,
      },
    };
    adapter.buildInteractiveCommand(opts);
    const bridgePath = join(configDir, 'codex', 'bridge.cjs');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(bridgePath, old, old);

    adapter.buildInteractiveCommand(opts);

    expect(statSync(bridgePath).mtimeMs).toBe(old.getTime());
  });

  it.each([
    {
      event: 'SessionStart',
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'thread-1',
        cwd: '/wt',
        transcript_path: '/tmp/rollout.jsonl',
        model: 'gpt-5.6-sol',
        permission_mode: 'bypassPermissions',
        source: 'startup',
      },
    },
    {
      event: 'PostToolUse',
      input: {
        hook_event_name: 'PostToolUse',
        session_id: 'thread-1',
        cwd: '/wt',
        transcript_path: '/tmp/rollout.jsonl',
        model: 'gpt-5.6-sol',
        permission_mode: 'bypassPermissions',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-1',
        tool_input: { command: 'git status --short' },
        tool_response: { output: '' },
      },
    },
  ])('delivers a Codex $event hook and exits successfully', async ({ event, input }) => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify(input),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: event,
        cwd: '/wt',
        session_id: 'thread-1',
      });
      expect(existsSync(diagnosticsPath)).toBe(false);
    } finally {
      await receiver.close();
    }
  });

  it('delivers a final assistant question as idle_prompt without its content', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            last_assistant_message: 'Proceed to plan phase?',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'Notification',
        cwd: '/wt',
        session_id: 'thread-1',
        message: 'idle_prompt',
      });
    } finally {
      await receiver.close();
    }
  });

  it('forwards authoritative cumulative usage as a UsageUpdate beside the lifecycle event', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveHooks(2);

    try {
      const [result, bodies] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            turn_id: 'turn-9',
            last_assistant_message: 'Done.',
            usage: {
              event_id: 'turn-9',
              input: 1_450,
              output: 320,
              cache_read: 180,
              cache_write: 40,
              total: 1_990,
            },
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(bodies).toEqual([
        { hook_event_name: 'Stop', cwd: '/wt', session_id: 'thread-1' },
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'thread-1',
          usage: {
            event_id: 'turn-9',
            input: 1_450,
            output: 320,
            cache_read: 180,
            cache_write: 40,
            total: 1_990,
          },
        },
      ]);
      expect(existsSync(diagnosticsPath)).toBe(false);
    } finally {
      await receiver.close();
    }
  });

  it('falls back to turn_id as the usage event id when the usage object names none', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveHooks(2);

    try {
      const [, bodies] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            turn_id: 'turn-9',
            usage: { input: 100, output: 20, cache_write: 5 },
          }),
        ),
        receiver.received,
      ]);

      const usage = (bodies[1] as { usage: Record<string, unknown> }).usage;
      expect(usage.event_id).toBe('turn-9');
      expect(usage.cache_write).toBe(5);
      expect(usage.cache_read).toBeUndefined();
    } finally {
      await receiver.close();
    }
  });

  it('drops malformed or partial usage — the lifecycle event still posts', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            turn_id: 'turn-9',
            usage: { input: 'not-a-number', output: 20, event_id: 'turn-9' },
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({ hook_event_name: 'Stop', cwd: '/wt', session_id: 'thread-1' });
    } finally {
      await receiver.close();
    }
  });

  it('emits no UsageUpdate when the payload carries no usage at all', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            turn_id: 'turn-9',
            last_assistant_message: 'Done.',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({ hook_event_name: 'Stop', cwd: '/wt', session_id: 'thread-1' });
    } finally {
      await receiver.close();
    }
  });

  it.each([
    {
      name: 'malformed JSON',
      input: '{',
      outcome: 'invalid-json',
    },
    {
      name: 'missing required fields',
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: '/wt',
      }),
      outcome: 'invalid-input',
    },
  ])('rejects $name as a genuine hook error', async ({ input, outcome }) => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');

    const result = await runBridge(
      bridgePath,
      'http://127.0.0.1:4567/hooks',
      diagnosticsPath,
      input,
    );

    expect(result).toEqual({ exitCode: 1, stderr: '' });
    const diagnostics = readFileSync(diagnosticsPath, 'utf8');
    expect(diagnostics).toContain(`"outcome":"${outcome}"`);
    expect(diagnostics).not.toContain('/wt');
    expect(diagnostics).not.toContain('thread-1');
  });

  it('fails open with diagnostics when the endpoint aborts its response', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook('abort');

    try {
      const [result] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      const diagnostics = readFileSync(diagnosticsPath, 'utf8');
      expect(diagnostics).toContain('"outcome":"request-error:ECONNRESET"');
    } finally {
      await receiver.close();
    }
  });

  it('fails open on an oversized hook input, recording the decline', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const oversized = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'thread-1',
      cwd: '/wt',
      tool_output: 'x'.repeat(1024 * 1024),
    });

    // The bridge exits while the parent is still writing stdin, so the EPIPE
    // error on this side is expected and must not fail the test.
    const result = await new Promise<{ exitCode: number; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          resolveNodeExecutable(),
          [bridgePath, 'http://127.0.0.1:4567/hooks', diagnosticsPath],
          { stdio: ['pipe', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(oversized);
      },
    );

    expect(result).toEqual({ exitCode: 0, stderr: '' });
    const diagnostics = readFileSync(diagnosticsPath, 'utf8');
    expect(diagnostics).toContain('"outcome":"input-too-large"');
    expect(diagnostics).not.toContain('/wt');
  });

  it('reports an endpoint rejection as a genuine hook error', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook('reject');

    try {
      const [result] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'SessionStart',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 1, stderr: '' });
      const diagnostics = readFileSync(diagnosticsPath, 'utf8');
      expect(diagnostics).toContain('"outcome":"http-error:400"');
    } finally {
      await receiver.close();
    }
  });

  it('rejects a missing required endpoint as a genuine hook error', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');

    const result = await runBridge(
      bridgePath,
      undefined,
      diagnosticsPath,
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'thread-1',
        cwd: '/wt',
      }),
    );

    expect(result).toEqual({ exitCode: 1, stderr: '' });
    const diagnostics = readFileSync(diagnosticsPath, 'utf8');
    expect(diagnostics).toContain('"outcome":"invalid-endpoint"');
    expect(diagnostics).not.toContain('/wt');
    expect(diagnostics).not.toContain('thread-1');
  });

  it('records a sanitized diagnostic when a hook cannot reach the endpoint', () => {
    const configDir = makeWorktree();
    new CodexAdapter().buildInteractiveCommand({
      cwd: makeWorktree(),
      hookChannel: {
        endpointUrl: 'http://127.0.0.1:4567/hooks',
        configDir,
      },
    });

    const bridgePath = join(configDir, 'codex', 'bridge.cjs');
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const result = spawnSync(
      resolveNodeExecutable(),
      [bridgePath, 'http://127.0.0.1:4567/hooks', diagnosticsPath],
      {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 'thread-1',
          cwd: '/wt',
        }),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const diagnostics = readFileSync(diagnosticsPath, 'utf8');
    expect(diagnostics).toContain('"event":"PostToolUse"');
    expect(diagnostics).toContain('"outcome":"request-error:ECONNREFUSED"');
    expect(diagnostics).not.toContain('/wt');
    expect(diagnostics).not.toContain('thread-1');
  });

  it('rebinds to the current-endpoint file when the launch-time endpoint is gone', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    // Write the current endpoint to the config file — simulates extension
    // startup writing the live endpoint for revived sessions.
    writeCurrentEndpoint(configDir, receiver.endpointUrl);

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          'http://127.0.0.1:1/hooks', // stale argv endpoint — refused, then abandoned
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'PostToolUse',
        cwd: '/wt',
        session_id: 'thread-1',
      });
      // The switch is the expected reload race: nothing is logged as a failure.
      expect(existsSync(diagnosticsPath)).toBe(false);
    } finally {
      await receiver.close();
    }
  });

  it('carries the karstLaunch generation onto the rebound endpoint', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();
    writeCurrentEndpoint(configDir, receiver.endpointUrl);

    try {
      const launchId = '9f6e3d2a-1b2c-4d5e-8f0a-1234567890ab';
      const [result] = await Promise.all([
        runBridge(
          bridgePath,
          `http://127.0.0.1:1/hooks?karstLaunch=${launchId}`,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      // The generation must survive the rebind: the endpoint's barrier decides
      // by it whether the hook is still this ticket's launch.
      expect(receiver.urls).toEqual([`/hooks?karstLaunch=${launchId}`]);
    } finally {
      await receiver.close();
    }
  });

  it('prefers the launch-time endpoint while its window is alive', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();
    // The extension file names a dead endpoint — but this session's own window
    // still serves its launch-time endpoint, and that one must win, or a second
    // window's activation would steal every other window's hooks.
    writeCurrentEndpoint(configDir, 'http://127.0.0.1:1/hooks');

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'PostToolUse',
        cwd: '/wt',
        session_id: 'thread-1',
      });
    } finally {
      await receiver.close();
    }
  });

  it('falls back to the current endpoint when the launch-time endpoint rejects', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    // A foreign process answering 400 on the stale port must not show a hook
    // failure: the extension's current endpoint is the session's real home.
    const stale = await receiveOneHook('reject');
    const live = await receiveOneHook();
    writeCurrentEndpoint(configDir, live.endpointUrl);

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          stale.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        live.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'PostToolUse',
        cwd: '/wt',
        session_id: 'thread-1',
      });
      expect(existsSync(diagnosticsPath)).toBe(false);
    } finally {
      await stale.close();
      await live.close();
    }
  });

  it('delivers every post of a multi-post event through the rebound endpoint', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    // The launch-time endpoint aborts mid-response; the whole event — the
    // lifecycle post AND its UsageUpdate — must still land on the live one.
    const stale = await receiveOneHook('abort');
    const live = await receiveHooks(2);
    writeCurrentEndpoint(configDir, live.endpointUrl);

    try {
      const [result, bodies] = await Promise.all([
        runBridge(
          bridgePath,
          stale.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
            turn_id: 'turn-9',
            usage: { event_id: 'turn-9', input: 10, output: 5 },
          }),
        ),
        live.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(bodies).toEqual([
        { hook_event_name: 'Stop', cwd: '/wt', session_id: 'thread-1' },
        {
          hook_event_name: 'UsageUpdate',
          cwd: '/wt',
          session_id: 'thread-1',
          usage: { event_id: 'turn-9', input: 10, output: 5 },
        },
      ]);
    } finally {
      await stale.close();
      await live.close();
    }
  });

  it('falls back to argv endpoint when config file is absent', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          receiver.endpointUrl,
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'PostToolUse',
        cwd: '/wt',
        session_id: 'thread-1',
      });
    } finally {
      await receiver.close();
    }
  });
});

describe('hookFailureLog endpoint file', () => {
  it('writeCurrentEndpoint and readCurrentEndpoint round-trip', () => {
    const configDir = makeWorktree();
    expect(readCurrentEndpoint(configDir)).toBeUndefined();
    writeCurrentEndpoint(configDir, 'http://127.0.0.1:5432/hooks');
    expect(readCurrentEndpoint(configDir)).toBe('http://127.0.0.1:5432/hooks');
  });

  it('currentEndpointPath resolves to the expected path', () => {
    expect(currentEndpointPath('/storage')).toBe('/storage/codex/current-endpoint');
  });

  it('readCurrentEndpoint returns undefined for a missing file', () => {
    expect(readCurrentEndpoint('/nonexistent/path')).toBeUndefined();
  });

  it('readCurrentEndpoint returns undefined for an empty file', () => {
    const configDir = makeWorktree();
    mkdirSync(join(configDir, 'codex'), { recursive: true });
    writeFileSync(join(configDir, 'codex', 'current-endpoint'), '');
    expect(readCurrentEndpoint(configDir)).toBeUndefined();
  });
});

describe('resolveNodeExecutable', () => {
  it('resolves and quotes a standalone Node executable from a path with spaces', () => {
    // Exercised against the HOST platform, deliberately. What this test is about
    // is the spaces; each platform's executable name and PATH separator has its
    // own test. Pinning it to 'darwin' cannot work on Windows, where the POSIX
    // branch splits PATH on ':' and a real absolute path starts `C:\`.
    const platform = process.platform;
    const binDir = join(makeWorktree(), 'bin with spaces');
    const nodePath = join(binDir, platform === 'win32' ? 'node.exe' : 'node');
    mkdirSync(binDir);
    writeFileSync(nodePath, '');
    chmodSync(nodePath, 0o755);

    expect(resolveNodeExecutable(binDir, platform)).toBe(nodePath);
  });

  it('uses the Windows executable name and PATH separator', () => {
    const first = makeWorktree();
    const second = makeWorktree();
    const nodePath = join(second, 'node.exe');
    writeFileSync(nodePath, '');

    expect(resolveNodeExecutable(`${first};${second}`, 'win32')).toBe(nodePath);
  });

  it('fails before launch when standalone Node is unavailable', () => {
    expect(() => resolveNodeExecutable('', 'darwin')).toThrow(
      /standalone Node\.js executable.*PATH/,
    );
  });
});

describe('codexHookNormalizer', () => {
  it('normalizes PermissionRequest without forwarding sensitive fields', async () => {
    const { codexHookNormalizer } = await import('./codex.js');
    const posted: unknown[] = [];
    const normalize = codexHookNormalizer((payload) => {
      posted.push(payload);
      return Promise.resolve();
    });
    await normalize({
      hook_event_name: 'PermissionRequest',
      session_id: 'thread-1',
      cwd: '/wt',
      prompt: 'secret prompt',
      tool_input: { command: 'secret command' },
    });
    expect(posted).toEqual([
      {
        hook_event_name: 'Notification',
        session_id: 'thread-1',
        cwd: '/wt',
        message: 'permission_prompt',
      },
    ]);
  });

  it('maps a Stop ending in a question to idle_prompt without forwarding the message', async () => {
    const { codexHookNormalizer } = await import('./codex.js');
    const posted: unknown[] = [];
    const normalize = codexHookNormalizer((payload) => {
      posted.push(payload);
      return Promise.resolve();
    });

    await normalize({
      hook_event_name: 'Stop',
      session_id: 'thread-1',
      cwd: '/wt',
      last_assistant_message: 'Proceed to plan phase?',
    });

    expect(posted).toEqual([
      {
        hook_event_name: 'Notification',
        session_id: 'thread-1',
        cwd: '/wt',
        message: 'idle_prompt',
      },
    ]);
  });

  it('keeps a completed Stop idle', async () => {
    const { codexHookNormalizer } = await import('./codex.js');
    const posted: unknown[] = [];
    const normalize = codexHookNormalizer((payload) => {
      posted.push(payload);
      return Promise.resolve();
    });

    await normalize({
      hook_event_name: 'Stop',
      session_id: 'thread-1',
      cwd: '/wt',
      last_assistant_message: 'Implementation complete.',
    });

    expect(posted).toEqual([
      {
        hook_event_name: 'Stop',
        session_id: 'thread-1',
        cwd: '/wt',
      },
    ]);
  });

  it('posts a UsageUpdate with the provider usage and event id alongside the lifecycle event', async () => {
    const { codexHookNormalizer } = await import('./codex.js');
    const posted: unknown[] = [];
    const normalize = codexHookNormalizer((payload) => {
      posted.push(payload);
      return Promise.resolve();
    });

    await normalize({
      hook_event_name: 'Stop',
      session_id: 'thread-1',
      cwd: '/wt',
      turn_id: 'turn-9',
      usage: {
        event_id: 'turn-9',
        input: 1_450,
        output: 320,
        cache_read: 180,
        cache_write: 40,
        total: 1_990,
      },
    });

    expect(posted).toEqual([
      { hook_event_name: 'Stop', session_id: 'thread-1', cwd: '/wt' },
      {
        hook_event_name: 'UsageUpdate',
        session_id: 'thread-1',
        cwd: '/wt',
        usage: {
          event_id: 'turn-9',
          input: 1_450,
          output: 320,
          cache_read: 180,
          cache_write: 40,
          total: 1_990,
        },
      },
    ]);
  });

  it('drops malformed usage in the normalizer too — lifecycle-only', async () => {
    const { codexHookNormalizer } = await import('./codex.js');
    const posted: unknown[] = [];
    const normalize = codexHookNormalizer((payload) => {
      posted.push(payload);
      return Promise.resolve();
    });

    await normalize({
      hook_event_name: 'Stop',
      session_id: 'thread-1',
      cwd: '/wt',
      usage: { input: 'ten', output: 2, event_id: 'turn-9' },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ hook_event_name: 'Stop', session_id: 'thread-1', cwd: '/wt' });
  });
});

describe('parseCodexJsonl', () => {
  it('returns the thread id and last completed agent message', () => {
    expect(parseCodexJsonl(okJsonl)).toEqual({
      sessionId: 'thread-7',
      raw: 'final',
    });
  });

  it.each([
    ['malformed JSON', '{"type":'],
    ['missing thread', JSON.stringify({ type: 'turn.completed' })],
    [
      'failed turn',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'bad' } }),
      ].join('\n'),
    ],
    [
      'error event',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'error', message: 'bad' }),
      ].join('\n'),
    ],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseCodexJsonl(stdout)).toThrow();
  });
});

describe('CodexAdapter headless execution', () => {
  it('forwards the abort signal into the headless spawn', async () => {
    let seenOpts: { signal?: AbortSignal } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okJsonl, stderr: '', exitCode: 0 };
    };
    const adapter = new CodexAdapter(spawn);
    const controller = new AbortController();
    const result = await adapter.runHeadless({
      prompt: 'hi',
      cwd: '/wt/a',
      signal: controller.signal,
    });
    expect(result.sessionId).toBe('thread-7');
    expect(seenOpts?.signal).toBe(controller.signal);
  });

  it('forwards the headless deadline into the spawn', async () => {
    let seenOpts: { timeoutMs?: number } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okJsonl, stderr: '', exitCode: 0 };
    };
    await new CodexAdapter(spawn).runHeadless({
      prompt: 'hi',
      cwd: '/wt/a',
      timeoutMs: 234_567,
    });
    expect(seenOpts?.timeoutMs).toBe(234_567);
  });

  it('forwards onOutput into the headless spawn, rendering JSONL as readable lines', async () => {
    let seenOpts: { onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: okJsonl, stderr: '', exitCode: 0 };
    };
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const onOutput = (chunk: { stream: 'stdout' | 'stderr'; text: string }): void => {
      rendered.push(chunk);
    };
    await new CodexAdapter(spawn).runHeadless({
      prompt: 'hi',
      cwd: '/wt/a',
      onOutput,
    });
    // The adapter wraps the caller's onOutput with the readable renderer: a
    // codex JSONL line arrives as the line a person can follow, not the raw
    // event.
    seenOpts?.onOutput?.({
      stream: 'stdout',
      text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\n',
    });
    expect(rendered).toEqual([{ stream: 'stdout', text: 'done\n' }]);
  });

  it('runs a fresh JSONL exec', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    const result = await new CodexAdapter(spawn).runHeadless({
      cwd: '/wt',
      prompt: '- inspect',
      permissionMode: 'bypassPermissions',
      model: 'custom-model',
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--model',
        'custom-model',
        '--ask-for-approval',
        'never',
        '--sandbox',
        'workspace-write',
        '--',
        '- inspect',
      ],
      '/wt',
      { signal: undefined },
    );
    expect(result).toEqual({
      sessionId: 'thread-7',
      verdict: null,
      raw: 'final',
    });
  });

  it('threads an effort into a headless run as --config model_reasoning_effort=<value>', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    await new CodexAdapter(spawn).runHeadless({
      cwd: '/wt',
      prompt: '- inspect',
      model: 'custom-model',
      effort: 'high',
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--model',
        'custom-model',
        '--config',
        'model_reasoning_effort=high',
        '--',
        '- inspect',
      ],
      '/wt',
      { signal: undefined },
    );
  });

  it('runs a resumed JSONL exec', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    await new CodexAdapter(spawn).runHeadless({
      cwd: '/wt',
      prompt: 'continue',
      resume: 'thread-7',
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        'thread-7',
        'continue',
      ],
      '/wt',
      { signal: undefined },
    );
  });

  it('reports bounded diagnostics for a nonzero exit', async () => {
    const stderr = 'x'.repeat(20_000);
    const adapter = new CodexAdapter(
      fakeSpawn({ stdout: '', stderr, exitCode: 2 }),
    );
    await expect(
      adapter.runHeadless({ cwd: '/wt', prompt: 'go' }),
    ).rejects.toThrow(/Codex failed \(exit 2\)/);
    try {
      await adapter.runHeadless({ cwd: '/wt', prompt: 'go' });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(9_000);
    }
  });

  it('names a usage limit instead of echoing the CLI failure', async () => {
    const adapter = new CodexAdapter(
      fakeSpawn({
        stdout: '',
        stderr: 'stream error: exceeded retry limit, last status: 429',
        exitCode: 1,
      }),
    );
    await expect(
      adapter.runHeadless({ cwd: '/wt', prompt: 'go' }),
    ).rejects.toThrow(/Codex usage limit reached/);
  });
});

describe('CodexAdapter approach materialization', () => {
  it('never claims or overwrites pre-existing repository skills', () => {
    const worktree = makeWorktree();
    const artifactDir = join(
      worktree,
      '.agents/skills/karst-rpi-planning',
    );
    const workflowDir = join(worktree, '.agents/skills/karst-rpi');
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(artifactDir, 'SKILL.md'), 'repository artifact');
    writeFileSync(join(workflowDir, 'SKILL.md'), 'repository workflow');

    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', [
        [
          'skills/planning/SKILL.md',
          '---\nname: planning\ndescription: Plan.\n---\nGenerated.',
        ],
      ]),
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [
          { kind: 'skill', relPath: 'skills/planning/SKILL.md' },
        ],
        workflow: [{ name: 'plan' }],
      },
    });

    expect(readFileSync(join(artifactDir, 'SKILL.md'), 'utf8')).toBe(
      'repository artifact',
    );
    expect(readFileSync(join(workflowDir, 'SKILL.md'), 'utf8')).toBe(
      'repository workflow',
    );
    expect(result.ownedPaths).not.toContain(artifactDir);
    expect(result.ownedPaths).not.toContain(workflowDir);
  });

  it('preserves skills and converts commands and agents to Codex skills', () => {
    const baseDir = makeBasePackage('rpi', [
      [
        'skills/planning/SKILL.md',
        '---\nname: planning\ndescription: Plan.\n---\nPlan.',
      ],
      ['skills/planning/references/checks.md', '# checks'],
      ['commands/review.md', '# Review command'],
      ['agents/researcher.md', '# Researcher'],
    ]);
    const worktree = makeWorktree();

    const result = new CodexAdapter().materializeApproach!({
      baseDir,
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [
          { kind: 'skill', relPath: 'skills/planning/SKILL.md' },
          { kind: 'command', relPath: 'commands/review.md' },
          { kind: 'agent', relPath: 'agents/researcher.md' },
        ],
      },
    });

    expect(
      readFileSync(
        join(
          worktree,
          '.agents/skills/karst-rpi-planning/references/checks.md',
        ),
        'utf8',
      ),
    ).toBe('# checks');
    expect(
      readFileSync(
        join(worktree, '.agents/skills/karst-rpi-review/SKILL.md'),
        'utf8',
      ),
    ).toContain('# Review command');
    expect(
      readFileSync(
        join(worktree, '.agents/skills/karst-rpi-researcher/SKILL.md'),
        'utf8',
      ),
    ).toContain('Delegate');
    expect(result.ownedPaths.every((path) => path.startsWith(worktree))).toBe(
      true,
    );
  });

  it('generates a workflow skill and native invocation', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'Research, Plan, Implement',
        workflow: [{ name: 'research' }, { name: 'plan' }],
      },
      cliContextPrefix: 'node cli.js context --ticket',
      cliStagePrefix: 'node cli.js stage impl pass --ticket',
      cliPhasePrefix: (name) => `node cli.js phase ${name} --ticket`,
    });

    expect(result.invocation).toBe('$karst-rpi');
    const body = readFileSync(
      join(worktree, '.agents/skills/karst-rpi/SKILL.md'),
      'utf8',
    );
    expect(body).toContain('name: karst-rpi');
    expect(body).toContain('node cli.js context --ticket $ARGUMENTS');
    expect(body).toContain(
      'node cli.js phase research --ticket $ARGUMENTS',
    );
    expect(body).toContain(
      'node cli.js stage impl pass --ticket $ARGUMENTS',
    );
  });

  it.each(['../escape', '/absolute', 'karst', 'a/b'])(
    'rejects unsafe approach id %s',
    (id) => {
      expect(() =>
        new CodexAdapter().materializeApproach!({
          baseDir: '/base',
          sessionDir: makeWorktree(),
          pkg: { id, label: id, workflow: [{ name: 'run' }] },
        }),
      ).toThrow(/unsafe|reserved/i);
    },
  );

  it('slugs a namespaced approach id into a legal workflow skill name', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('superpowers:writing-plans', []),
      sessionDir: worktree,
      pkg: {
        id: 'superpowers:writing-plans',
        label: 'Write a plan first',
        workflow: [{ name: 'plan' }, { name: 'implement' }],
      },
    });

    expect(result.invocation).toBe('$karst-superpowers-writing-plans');
    const skillDir = join(worktree, '.agents/skills/karst-superpowers-writing-plans');
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    expect(body).toContain('name: karst-superpowers-writing-plans');
  });

  // A relaunch re-renders the generated workflow skill with the CURRENT stage
  // marker. Skipping the write because the dir existed left the stale body —
  // whose closing step names a stage the CLI now refuses (UNKNOWN-COMMAND-ISSUE
  // sibling: the artifact karst generates must never outlive its inputs).
  it('re-renders an existing generated workflow skill with the current stage marker', () => {
    const worktree = makeWorktree();
    const baseDir = makeBasePackage('rpi', []);
    const pkg = { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] };
    const adapter = new CodexAdapter();
    adapter.materializeApproach!({
      baseDir, sessionDir: worktree, pkg,
      cliStagePrefix: 'node "/ext/cli.js" stage impl pass',
    });
    adapter.materializeApproach!({
      baseDir, sessionDir: worktree, pkg,
      cliStagePrefix: 'node "/ext/cli.js" stage fix pass',
    });

    const body = readFileSync(join(worktree, '.agents/skills/karst-rpi/SKILL.md'), 'utf8');
    expect(body).toContain('stage fix pass');
    expect(body).not.toContain('stage impl pass');
  });

  it('never overwrites a workflow skill karst did not generate', () => {
    const worktree = makeWorktree();
    const skillPath = join(worktree, '.agents/skills/karst-rpi/SKILL.md');
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, 'checked into the repo');

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
    });

    expect(readFileSync(skillPath, 'utf8')).toBe('checked into the repo');
  });
});
