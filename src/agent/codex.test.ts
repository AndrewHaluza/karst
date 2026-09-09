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
  type SpawnHeadless,
} from './codex.js';
import { resolveNodeExecutable } from './nodeExecutable.js';
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
  provider?: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [bridgePath, endpointUrl ?? '', diagnosticsPath, provider ?? 'codex'];
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
      expectedBody: {
        hook_event_name: 'SessionStart',
        cwd: '/wt',
        session_id: 'thread-1',
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
      expectedBody: {
        hook_event_name: 'PostToolUse',
        cwd: '/wt',
        session_id: 'thread-1',
        tool_name: 'Bash',
      },
    },
  ])('delivers a Codex $event hook and exits successfully', async ({ event, input, expectedBody }) => {
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
      expect(body).toEqual(expectedBody);
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

  it('writes current-endpoint for every BRIDGE_PROVIDERS entry (codex, opencode, claude)', () => {
    const configDir = makeWorktree();
    writeCurrentEndpoint(configDir, 'http://127.0.0.1:5051/hooks');
    for (const provider of ['codex', 'opencode', 'claude'] as const) {
      const target = currentEndpointPath(configDir, provider);
      expect(existsSync(target), `${provider} endpoint file`).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('http://127.0.0.1:5051/hooks');
      expect(readCurrentEndpoint(configDir, provider)).toBe('http://127.0.0.1:5051/hooks');
    }
  });
});

describe('parameterized bridge provider', () => {
  it('reads current-endpoint from configDir/<provider> when provider argv is given', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'claude', 'hook-failures.jsonl');
    const receiver = await receiveOneHook();

    // Write the current endpoint to the claude provider dir (not codex).
    mkdirSync(join(configDir, 'claude'), { recursive: true });
    writeFileSync(join(configDir, 'claude', 'current-endpoint'), receiver.endpointUrl, { mode: 0o600 });

    try {
      const [result, body] = await Promise.all([
        runBridge(
          bridgePath,
          'http://127.0.0.1:1/hooks', // stale argv endpoint — refused
          diagnosticsPath,
          JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'thread-1',
            cwd: '/wt',
          }),
          'claude', // provider argv
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'Stop',
        cwd: '/wt',
        session_id: 'thread-1',
      });
    } finally {
      await receiver.close();
    }
  });

  it('rejects a non-loopback fallback URL read from the provider endpoint file', async () => {
    const configDir = makeWorktree();
    const bridgePath = materializeBridge(configDir);
    const diagnosticsPath = join(configDir, 'claude', 'hook-failures.jsonl');

    mkdirSync(join(configDir, 'claude'), { recursive: true });
    writeFileSync(
      join(configDir, 'claude', 'current-endpoint'),
      'http://evil.com/hooks',
      { mode: 0o600 },
    );

    const result = await runBridge(
      bridgePath,
      'http://127.0.0.1:1/hooks',
      diagnosticsPath,
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'thread-1',
        cwd: '/wt',
      }),
      'claude',
    );

    // The non-loopback URL is rejected; no valid fallback → request-error logged.
    // Bridge exits 0 (documented: exit 0 means "ran", not "delivered").
    expect(result.exitCode).toBe(0);
    expect(existsSync(diagnosticsPath)).toBe(true);
    expect(readFileSync(diagnosticsPath, 'utf8')).toContain('request-error');
  });

  it('forwards claude Notification events (permission/idle) through the bridge', async () => {
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
            hook_event_name: 'Notification',
            session_id: 'thread-1',
            cwd: '/wt',
            message: 'permission_prompt',
          }),
        ),
        receiver.received,
      ]);

      expect(result).toEqual({ exitCode: 0, stderr: '' });
      expect(body).toEqual({
        hook_event_name: 'Notification',
        cwd: '/wt',
        session_id: 'thread-1',
        message: 'permission_prompt',
      });
    } finally {
      await receiver.close();
    }
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

  // Same seam rule as opencode: a turn that completed without an agent message
  // is an empty answer, not an execution failure.
  it('reads a completed turn with no agent message as an empty answer', () => {
    const nd = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexJsonl(nd)).toEqual({ sessionId: 't', raw: '' });
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
        '--config',
        'mcp_servers={}',
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

  it('isolates the run from the operator\'s configured MCP servers', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    await new CodexAdapter(spawn).runHeadless({ cwd: '/wt', prompt: '- inspect' });
    const args = spawn.mock.calls[0]![1] as string[];
    const idx = args.indexOf('--config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('mcp_servers={}');
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
        '--config',
        'mcp_servers={}',
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
        '--config',
        'mcp_servers={}',
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
    expect(body).toContain('$KARST context --ticket $ARGUMENTS');
    expect(body).toContain('$KARST phase research --ticket $ARGUMENTS');
    expect(body).toContain('node cli.js stage impl pass --ticket $ARGUMENTS');
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

  it('bare direct + cliContextPrefix writes karst-start-task skill and returns startTaskInvocation', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
    });
    const startTaskSkillDir = join(worktree, '.agents', 'skills', 'karst-start-task');
    expect(existsSync(startTaskSkillDir)).toBe(true);
    const body = readFileSync(join(startTaskSkillDir, 'SKILL.md'), 'utf8');
    expect(body).toContain('name: karst-start-task');
    expect(body).toContain('---');
    expect(body).toContain('node "/ext/cli.js" context --db "/x.db"');
    expect(result.startTaskInvocation).toBe('/karst-start-task');
  });

  it('bare direct without cliContextPrefix returns no startTaskInvocation', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
    });
    expect(result.startTaskInvocation).toBeUndefined();
    expect(
      existsSync(join(worktree, '.agents', 'skills', 'karst-start-task')),
    ).toBe(false);
  });

  it.each(['start-task', 'fix', 'resolve-conflict', 'resume'])(
    'an approach id slugging to reserved name %s throws',
    (id) => {
      expect(() =>
        new CodexAdapter().materializeApproach!({
          baseDir: '/base',
          sessionDir: makeWorktree(),
          pkg: { id, label: id, workflow: [{ name: 'run' }] },
          cliContextPrefix: 'node cli.js context',
        }),
      ).toThrow(/reserved|collides/);
    },
  );

  it('a workflow launch returns both invocation and startTaskInvocation', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
      cliContextPrefix: 'node cli.js context --ticket',
    });
    expect(result.invocation).toBe('$karst-rpi');
    expect(result.startTaskInvocation).toBe('/karst-start-task');
  });

  it('all four created files appear in ownedPaths on first creation only', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('rpi', [
        ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
        ['agents/researcher.md', '# Researcher'],
      ]),
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [
          { kind: 'skill', relPath: 'skills/planning/SKILL.md' },
          { kind: 'agent', relPath: 'agents/researcher.md' },
        ],
      },
      cliContextPrefix: 'node cli.js context --ticket',
      cliTestPrefix: 'node cli.js test',
    });
    expect(result.ownedPaths).toContain(
      join(worktree, '.agents', 'skills', 'karst-rpi-planning'),
    );
    expect(result.ownedPaths).toContain(
      join(worktree, '.agents', 'skills', 'karst-rpi-researcher'),
    );
    expect(result.ownedPaths).toContain(
      join(worktree, '.agents', 'skills', 'karst-test'),
    );
    expect(result.ownedPaths).toContain(
      join(worktree, '.agents', 'skills', 'karst-start-task'),
    );
    expect(result.ownedPaths).toContain(
      join(worktree, '.agents', 'skills', 'karst-resume'),
    );
    expect(result.ownedPaths).toHaveLength(5);
  });

  it('second materializeApproach call does NOT add to ownedPaths', () => {
    const worktree = makeWorktree();
    const adapter = new CodexAdapter();
    const first = adapter.materializeApproach!({
      baseDir: makeBasePackage('rpi', [
        ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
      ]),
      sessionDir: worktree,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }],
      },
      cliContextPrefix: 'node cli.js context --ticket',
      cliTestPrefix: 'node cli.js test',
    });
    expect(first.ownedPaths.length).toBeGreaterThan(0);
    const second = adapter.materializeApproach!({
      baseDir: makeBasePackage('rpi', []),
      sessionDir: worktree,
      pkg: { id: 'rpi', label: 'RPI' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliTestPrefix: 'node cli.js test',
    });
    expect(second.ownedPaths).toEqual([]);
  });

  it('(a) with all four prefixes, four karst-prefixed skill dirs exist', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
    });

    const skillsDir = join(worktree, '.agents', 'skills');
    for (const basename of ['karst-start-task', 'karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
      const skillPath = join(skillsDir, basename, 'SKILL.md');
      expect(existsSync(skillPath), `${basename}/SKILL.md should exist`).toBe(true);
    }
  });

  it('(b) with only cliContextPrefix, exactly two skill dirs exist and neither is fix nor resolve-conflict', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
    });

    const skillsDir = join(worktree, '.agents', 'skills');
    expect(existsSync(join(skillsDir, 'karst-start-task', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'karst-resume', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'karst-fix', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(skillsDir, 'karst-resolve-conflict', 'SKILL.md'))).toBe(false);
  });

  it('(c) an approach id colliding with any reserved basename throws', () => {
    for (const reserved of ['start-task', 'resume', 'fix', 'resolve-conflict']) {
      expect(() =>
        new CodexAdapter().materializeApproach!({
          baseDir: '/base',
          sessionDir: makeWorktree(),
          pkg: { id: reserved, label: reserved },
          cliContextPrefix: 'node cli.js context --ticket',
        }),
      ).toThrow(/reserved|collides/);
    }
  });

  it('(d) each written SKILL.md has exactly one leading frontmatter block', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
    });

    const skillsDir = join(worktree, '.agents', 'skills');
    for (const basename of ['karst-start-task', 'karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
      const body = readFileSync(join(skillsDir, basename, 'SKILL.md'), 'utf8');
      const leadingFrontmatterMatches = body.match(/^---\n[\s\S]*?\n---\n/u);
      expect(leadingFrontmatterMatches, `${basename} should have exactly one frontmatter block`).toHaveLength(1);
    }
  });

  it('(e) all four karst-prefixed skill dirs appear in ownedPaths on first creation only', () => {
    const worktree = makeWorktree();
    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
    });
    expect(result.ownedPaths).toContain(join(worktree, '.agents', 'skills', 'karst-start-task'));
    expect(result.ownedPaths).toContain(join(worktree, '.agents', 'skills', 'karst-resume'));
    expect(result.ownedPaths).toContain(join(worktree, '.agents', 'skills', 'karst-fix'));
    expect(result.ownedPaths).toContain(join(worktree, '.agents', 'skills', 'karst-resolve-conflict'));
  });

  it('the written SKILL.md contains exactly ONE leading frontmatter block', () => {
    const worktree = makeWorktree();
    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
    });
    const body = readFileSync(
      join(worktree, '.agents', 'skills', 'karst-start-task', 'SKILL.md'),
      'utf8',
    );
    const leadingFrontmatterMatches = body.match(/^---\n[\s\S]*?\n---\n/u);
    expect(leadingFrontmatterMatches).toHaveLength(1);
  });

  it('(alias-a) two alias tickets and all four prefixes yield six alias files plus four generic', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
      aliasTickets: [
        { key: 'PROJ-1', stageCurrent: 'impl' },
        { key: 'PROJ-2', stageCurrent: 'uat' },
      ],
    });

    const skillsDir = join(worktree, '.agents', 'skills');
    // Generic four
    for (const basename of ['karst-start-task', 'karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
      expect(existsSync(join(skillsDir, basename, 'SKILL.md')), `${basename}`).toBe(true);
    }
    // Alias six: 3 commands × 2 tickets
    for (const key of ['PROJ-1', 'PROJ-2']) {
      for (const basename of ['karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
        expect(existsSync(join(skillsDir, `${basename}-${key}`, 'SKILL.md')), `${basename}-${key}`).toBe(true);
      }
    }
    // No start-task alias
    for (const key of ['PROJ-1', 'PROJ-2']) {
      expect(existsSync(join(skillsDir, `karst-start-task-${key}`))).toBe(false);
    }
  });

  it('(alias-b) an alias body contains the literal ticket key and no $ARGUMENTS', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      aliasTickets: [{ key: 'PROJ-1', stageCurrent: 'impl' }],
    });

    const body = readFileSync(
      join(worktree, '.agents', 'skills', 'karst-resume-PROJ-1', 'SKILL.md'),
      'utf8',
    );
    expect(body).toContain('PROJ-1');
    expect(body).not.toContain('$ARGUMENTS');
    expect(body).toContain('This command is for ticket `PROJ-1`');
  });

  it('(alias-c) no start-task-<KEY> file is written', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      aliasTickets: [{ key: 'PROJ-1', stageCurrent: 'impl' }],
    });

    expect(existsSync(join(worktree, '.agents', 'skills', 'karst-start-task-PROJ-1'))).toBe(false);
  });

  it('(alias-d) all alias files appear in ownedPaths on first creation', () => {
    const worktree = makeWorktree();

    const result = new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
      aliasTickets: [
        { key: 'PROJ-1', stageCurrent: 'impl' },
        { key: 'PROJ-2', stageCurrent: 'uat' },
      ],
    });

    // Alias skill dirs are owned on first creation — each gets its own entry
    const ownedBasenames = result.ownedPaths.map((p) => {
      const parts = p.split('/');
      return parts[parts.length - 1];
    });
    for (const key of ['proj-1', 'proj-2']) {
      for (const base of ['karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
        expect(ownedBasenames).toContain(`${base}-${key}`);
      }
    }
  });

  it('(alias-e) an empty aliasTickets writes only the generic four', () => {
    const worktree = makeWorktree();

    new CodexAdapter().materializeApproach!({
      baseDir: makeBasePackage('bare', []),
      sessionDir: worktree,
      pkg: { id: 'bare', label: 'Bare' },
      cliContextPrefix: 'node cli.js context --ticket',
      cliFixBriefPrefix: 'node cli.js fix-brief',
      cliConflictBriefPrefix: 'node cli.js conflict-brief',
      aliasTickets: [],
    });

    const skillsDir = join(worktree, '.agents', 'skills');
    for (const basename of ['karst-start-task', 'karst-resume', 'karst-fix', 'karst-resolve-conflict']) {
      expect(existsSync(join(skillsDir, basename, 'SKILL.md')), `${basename}`).toBe(true);
    }
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(skillsDir) as string[];
    expect(dirs.filter((d: string) => d.includes('PROJ'))).toHaveLength(0);
  });
});
