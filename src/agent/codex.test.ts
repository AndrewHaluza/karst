import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    expect(sessionStart).toContain(
      `command = "\\\"${resolveNodeExecutable()}\\\" `,
    );
  });
});

describe('resolveNodeExecutable', () => {
  it('resolves and quotes a standalone Node executable from a path with spaces', () => {
    const binDir = join(makeWorktree(), 'bin with spaces');
    const nodePath = join(binDir, 'node');
    mkdirSync(binDir);
    writeFileSync(nodePath, '');
    chmodSync(nodePath, 0o755);

    expect(resolveNodeExecutable(binDir, 'darwin')).toBe(nodePath);
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
    );
    expect(result).toEqual({
      sessionId: 'thread-7',
      verdict: null,
      raw: 'final',
    });
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
    );
  });

  it('reports bounded diagnostics for a nonzero exit', async () => {
    const stderr = 'x'.repeat(20_000);
    const adapter = new CodexAdapter(
      fakeSpawn({ stdout: '', stderr, exitCode: 2 }),
    );
    await expect(
      adapter.runHeadless({ cwd: '/wt', prompt: 'go' }),
    ).rejects.toThrow(/codex exited 2/);
    try {
      await adapter.runHeadless({ cwd: '/wt', prompt: 'go' });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(9_000);
    }
  });
});

describe('CodexAdapter approach materialization', () => {
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
});
