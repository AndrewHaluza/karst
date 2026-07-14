import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, makeDefaultSpawn, type SpawnHeadless, type SpawnImpl } from './claude.js';

/** A fake headless spawner returning canned stdout/exit for runHeadless tests. */
function fakeSpawn(result: { stdout: string; exitCode: number; stderr?: string }): SpawnHeadless {
  return async () => ({ stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode });
}

describe('makeDefaultSpawn', () => {
  /** A fake child_process.ChildProcess: stdout/stderr are real EventEmitters
   * (so `.on('data', ...)` works), stdin is a stub with a spyable `.end`, and
   * the child itself emits `error`/`close` like the real ChildProcess does. */
  function fakeChild(): EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
  } {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    return child;
  }

  it('spawns with stdin closed so `claude -p` never waits on an open stdin pipe', async () => {
    let seenOptions: unknown;
    const child = fakeChild();
    const spawnImpl = vi.fn((_command: string, _args: readonly string[], options: unknown) => {
      seenOptions = options;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as SpawnImpl;

    const spawnHeadless = makeDefaultSpawn(spawnImpl);
    const result = await spawnHeadless('claude', ['-p', 'hi'], '/wt/a');

    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });

    const stdio = (seenOptions as { stdio?: unknown[] } | undefined)?.stdio;
    const stdioClosesStdin = Array.isArray(stdio) && stdio[0] === 'ignore';
    const stdinExplicitlyEnded = child.stdin.end.mock.calls.length > 0;
    expect(stdioClosesStdin || stdinExplicitlyEnded).toBe(true);
  });

  it('still accumulates stdout/stderr and resolves on close', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out'));
        child.stderr.emit('data', Buffer.from('err'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    const spawnHeadless = makeDefaultSpawn(spawnImpl);
    const result = await spawnHeadless('claude', [], '/wt/a');
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('rejects when the child emits an error', async () => {
    const child = fakeChild();
    const boom = new Error('boom');
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('error', boom));
      return child;
    }) as unknown as SpawnImpl;

    const spawnHeadless = makeDefaultSpawn(spawnImpl);
    await expect(spawnHeadless('claude', [], '/wt/a')).rejects.toThrow('boom');
  });
});

describe('ClaudeAdapter.buildInteractiveCommand', () => {
  const adapter = new ClaudeAdapter();

  it('returns the claude bin with no -p (interactive, not headless)', () => {
    const { command, args } = adapter.buildInteractiveCommand({ cwd: '/wt/a' });
    expect(command).toBe('claude');
    expect(args).not.toContain('-p');
  });

  it('threads --settings <path> when a settingsPath is given', () => {
    const { args } = adapter.buildInteractiveCommand({
      cwd: '/wt/a',
      settingsPath: '/tmp/hooks.json',
    });
    expect(args).toContain('--settings');
    expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/hooks.json');
  });

  it('omits --settings when no path is given', () => {
    const { args } = adapter.buildInteractiveCommand({ cwd: '/wt/a' });
    expect(args).not.toContain('--settings');
  });

  it('advertises capabilities (http hooks + resume)', () => {
    expect(adapter.capabilities.httpHooks).toBe(true);
    expect(adapter.capabilities.resume).toBe(true);
  });

});

describe('buildInteractiveCommand initialPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('appends initialPrompt as a positional after a `--` end-of-options separator', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      settingsPath: '/s.json',
      initialPrompt: 'do the thing',
    });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--settings', '/s.json', '--', 'do the thing']);
  });

  it('appends initialPrompt even without settingsPath', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' });
    expect(cmd.args).toEqual(['--', 'go']);
  });

  it('guards a prompt that starts with dashes (YAML frontmatter) so it is not flag-parsed', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      initialPrompt: '---\nname: x\n---\nbody',
    });
    // `--` must precede the prompt, else `claude` reads `---...` as an option and exits 1.
    expect(cmd.args[0]).toBe('--');
    expect(cmd.args[1]).toBe('---\nname: x\n---\nbody');
  });

  it('omits the positional when initialPrompt is absent', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', settingsPath: '/s.json' });
    expect(cmd.args).toEqual(['--settings', '/s.json']);
  });

  it('omits the positional when initialPrompt is empty', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: '' });
    expect(cmd.args).toEqual([]);
  });

  it('appends extraArgs (e.g. --plugin-dir) before the positional', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      settingsPath: '/s.json',
      extraArgs: ['--plugin-dir', '/plug'],
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--settings', '/s.json', '--plugin-dir', '/plug', '--', 'go']);
  });

  it('threads --model when a model is given (before the positional seed)', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      settingsPath: '/s.json',
      model: 'claude-opus-4-8',
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--settings', '/s.json', '--model', 'claude-opus-4-8', '--', 'go']);
  });

  it('omits --model when none is given', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' });
    expect(cmd.args).not.toContain('--model');
  });

  it('threads --resume when a session id is given', () => {
    const cmd = new ClaudeAdapter().buildInteractiveCommand({ cwd: '/wt', resume: 'sess-9' });
    expect(cmd.args).toContain('--resume');
    expect(cmd.args[cmd.args.indexOf('--resume') + 1]).toBe('sess-9');
  });

  it('omits --resume when no session id is given', () => {
    const cmd = new ClaudeAdapter().buildInteractiveCommand({ cwd: '/wt' });
    expect(cmd.args).not.toContain('--resume');
  });

  it('appends extraArgs with no initialPrompt', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      extraArgs: ['--plugin-dir', '/plug'],
    });
    expect(cmd.args).toEqual(['--plugin-dir', '/plug']);
  });
});

describe('ClaudeAdapter.materializeApproach', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'karst-mat-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const adapter = new ClaudeAdapter();

  function writeNeutral(baseDir: string, id: string, files: { relPath: string; body: string }[]): void {
    for (const f of files) {
      const dest = join(baseDir, id, f.relPath);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, f.body);
    }
  }

  it('builds a .claude-plugin dir with plugin.json and copies agents/skills/commands', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    writeNeutral(baseDir, 'rpi', [
      { relPath: 'agents/research.md', body: '# research' },
      { relPath: 'skills/writing-plans/SKILL.md', body: '# plans' },
      { relPath: 'commands/plan.md', body: '# plan cmd' },
    ]);

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        entrypoint: 'research',
        artifacts: [
          { kind: 'agent', relPath: 'agents/research.md' },
          { kind: 'skill', relPath: 'skills/writing-plans/SKILL.md' },
          { kind: 'command', relPath: 'commands/plan.md' },
        ],
      },
    });

    const pluginDirIdx = result.extraArgs.indexOf('--plugin-dir');
    expect(pluginDirIdx).toBeGreaterThanOrEqual(0);
    const pluginDir = result.extraArgs[pluginDirIdx + 1]!;

    // plugin manifest exists and is valid JSON with a name.
    const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    expect(typeof manifest.name).toBe('string');

    // components copied preserving structure.
    expect(readFileSync(join(pluginDir, 'agents', 'research.md'), 'utf8')).toBe('# research');
    expect(readFileSync(join(pluginDir, 'skills', 'writing-plans', 'SKILL.md'), 'utf8')).toBe('# plans');
    expect(readFileSync(join(pluginDir, 'commands', 'plan.md'), 'utf8')).toBe('# plan cmd');
  });

  it('returns empty extraArgs when the package has no artifacts', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'bare', label: 'Bare' },
    });
    expect(result.extraArgs).toEqual([]);
  });

  it('materializes the generated /karst:<id> command into the sibling karst plugin for a workflow-only package (zero artifacts)', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        workflow: [
          { name: 'research', command: '/rpi:research' },
          { name: 'plan' },
        ],
      },
    });

    expect(result.extraArgs).toContain(join(sessionDir, '.karst-plugin', 'karst'));

    const cmdPath = join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md');
    expect(existsSync(cmdPath)).toBe(true);
    const body = readFileSync(cmdPath, 'utf8');
    expect(body).toContain('/karst:rpi');
    expect(body).toContain('/rpi:research');
  });

  it('materializes both artifacts (in the <id> plugin) and the generated command (in the karst plugin) when the package has both', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    writeNeutral(baseDir, 'rpi', [{ relPath: 'agents/research.md', body: '# research' }]);

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'agent', relPath: 'agents/research.md' }],
        workflow: [{ name: 'research', command: '/rpi:research' }],
      },
    });

    const idPluginDir = join(sessionDir, '.karst-plugin', 'rpi');
    expect(result.extraArgs).toContain(idPluginDir);
    expect(result.extraArgs).toContain(join(sessionDir, '.karst-plugin', 'karst'));

    expect(readFileSync(join(idPluginDir, 'agents', 'research.md'), 'utf8')).toBe('# research');
    expect(existsSync(join(idPluginDir, 'commands', 'karst.md'))).toBe(false);
    expect(existsSync(join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md'))).toBe(true);
  });

  it('returns empty extraArgs when the package has neither artifacts nor a workflow', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'bare', label: 'Bare' },
    });
    expect(result.extraArgs).toEqual([]);
  });

  it('rejects an approach package whose id is the reserved "karst" plugin name', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    expect(() =>
      adapter.materializeApproach!({
        baseDir,
        sessionDir,
        pkg: {
          id: 'karst',
          label: 'Karst',
          workflow: [{ name: 'research', command: '/karst:research' }],
        },
      }),
    ).toThrow(/reserved/i);
  });

  it('materializes a soloAgent alone (no artifacts/workflow) into agents/<name>.md and returns --plugin-dir', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'single-subagent', label: 'Single subagent' },
      soloAgent: { name: 'reviewer', body: '# reviewer\n\nDo review things.' },
    });

    const pluginDirIdx = result.extraArgs.indexOf('--plugin-dir');
    expect(pluginDirIdx).toBeGreaterThanOrEqual(0);
    const pluginDir = result.extraArgs[pluginDirIdx + 1]!;
    expect(readFileSync(join(pluginDir, 'agents', 'reviewer.md'), 'utf8')).toBe(
      '# reviewer\n\nDo review things.',
    );
  });

  it('rejects a malicious soloAgent.name that could escape the plugin dir', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    expect(() =>
      adapter.materializeApproach!({
        baseDir,
        sessionDir,
        pkg: { id: 'single-subagent', label: 'Single subagent' },
        soloAgent: { name: '../x', body: 'evil' },
      }),
    ).toThrow();
  });

  it('materializes the orchestrator into a sibling karst plugin as commands/<id>.md', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        workflow: [
          { name: 'research', command: '/rpi:research' },
          { name: 'plan' },
        ],
      },
    });

    const karstCmd = join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md');
    const karstManifest = join(sessionDir, '.karst-plugin', 'karst', '.claude-plugin', 'plugin.json');
    expect(existsSync(karstCmd)).toBe(true);
    expect(JSON.parse(readFileSync(karstManifest, 'utf8')).name).toBe('karst');
    // the <id> plugin must NOT contain the orchestrator anymore
    expect(existsSync(join(sessionDir, '.karst-plugin', 'rpi', 'commands', 'karst.md'))).toBe(false);
    // both plugin dirs are passed
    const dirs = result.extraArgs.filter((_, i) => result.extraArgs[i - 1] === '--plugin-dir');
    expect(dirs).toContain(join(sessionDir, '.karst-plugin', 'karst'));
    expect(dirs).toContain(join(sessionDir, '.karst-plugin', 'rpi'));
  });
});

describe('ClaudeAdapter.runHeadless', () => {
  it('parses the session id and result text from claude JSON output', async () => {
    const json = JSON.stringify({ session_id: 'sess-9', result: '["api"]' });
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: json, exitCode: 0 }));
    const r = await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' });
    expect(r.sessionId).toBe('sess-9');
    expect(r.raw).toBe('["api"]');
  });

  it('passes -p and --output-format json to the CLI', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' });
    expect(seen.args).toContain('-p');
    expect(seen.args).toContain('--output-format');
    expect(seen.args[seen.args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('rejects on a nonzero exit code', async () => {
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: '', exitCode: 1, stderr: 'boom' }));
    await expect(adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' })).rejects.toThrow(/boom|exit/i);
  });

  it('rejects when stdout is not valid JSON', async () => {
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: 'not json', exitCode: 0 }));
    await expect(adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' })).rejects.toThrow(/JSON/i);
  });
});
