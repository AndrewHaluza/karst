import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ClaudeAdapter, makeDefaultSpawn, type SpawnHeadless, type SpawnImpl } from './claude.js';
import { HOOK_BRIDGE } from './hookBridge.js';

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

    // The child is spawned detached so an abort/timeout can kill its whole
    // process group (killTree), like workflow/gates/run.ts.
    const detached = (seenOptions as { detached?: boolean } | undefined)?.detached;
    expect(detached).toBe(true);
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

  it('materializes --settings from a provider-neutral hook channel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claude-hooks-'));
    try {
      const { args } = adapter.buildInteractiveCommand({
        cwd: '/wt/a',
        hookChannel: {
          endpointUrl: 'http://127.0.0.1:4567/hooks',
          configDir: dir,
        },
      });
      expect(args).toContain('--settings');
      expect(args[args.indexOf('--settings') + 1]).toBe(
        join(dir, 'karst-hooks.4567.settings.json'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the shared bridge script to configDir/claude/bridge.cjs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claude-hooks-'));
    try {
      adapter.buildInteractiveCommand({
        cwd: '/wt/a',
        hookChannel: {
          endpointUrl: 'http://127.0.0.1:4567/hooks',
          configDir: dir,
        },
      });
      const bridgePath = join(dir, 'claude', 'bridge.cjs');
      expect(existsSync(bridgePath)).toBe(true);
      expect(readFileSync(bridgePath, 'utf8')).toBe(HOOK_BRIDGE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace the shared bridge when content is identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claude-hooks-'));
    try {
      adapter.buildInteractiveCommand({
        cwd: '/wt/a',
        hookChannel: {
          endpointUrl: 'http://127.0.0.1:4567/hooks',
          configDir: dir,
        },
      });
      const bridgePath = join(dir, 'claude', 'bridge.cjs');
      const stat = require('node:fs').statSync(bridgePath);
      const old = new Date('2020-01-01T00:00:00Z');
      require('node:fs').utimesSync(bridgePath, old, old);

      adapter.buildInteractiveCommand({
        cwd: '/wt/a',
        hookChannel: {
          endpointUrl: 'http://127.0.0.1:4567/hooks',
          configDir: dir,
        },
      });

      expect(require('node:fs').statSync(bridgePath).mtimeMs).toBe(old.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits bridge commands for lifecycle events in the settings JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claude-hooks-'));
    try {
      adapter.buildInteractiveCommand({
        cwd: '/wt/a',
        hookChannel: {
          endpointUrl: 'http://127.0.0.1:4567/hooks',
          configDir: dir,
        },
      });
      const settingsPath = join(dir, 'karst-hooks.4567.settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // Lifecycle events should be bridged (type:command, not type:http)
      for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit', 'SessionStart']) {
        const hook = settings.hooks[event][0].hooks[0];
        expect(hook.type, `${event} type`).toBe('command');
        expect(hook.command, `${event} command`).toContain('bridge.cjs');
      }
      // PostToolUse stays type:http
      const postHook = settings.hooks.PostToolUse[0].hooks[0];
      expect(postHook.type).toBe('http');
      expect(postHook.url).toBe('http://127.0.0.1:4567/hooks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits --settings when no path is given', () => {
    const { args } = adapter.buildInteractiveCommand({ cwd: '/wt/a' });
    expect(args).not.toContain('--settings');
  });

  it('advertises capabilities (http hooks + resume)', () => {
    expect(adapter.capabilities.lifecycleEvents).toBe(true);
    expect(adapter.capabilities.resume).toBe(true);
  });

  it('advertises interactive usage — session transcript carries per-call token counts', () => {
    expect(adapter.capabilities.interactiveUsage).toBe(true);
  });

});

describe('buildInteractiveCommand initialPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('appends initialPrompt as a positional after a `--` end-of-options separator', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      initialPrompt: 'do the thing',
    });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--', 'do the thing']);
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
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt' });
    expect(cmd.args).toEqual([]);
  });

  it('omits the positional when initialPrompt is empty', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: '' });
    expect(cmd.args).toEqual([]);
  });

  it('appends extraArgs (e.g. --plugin-dir) before the positional', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      extraArgs: ['--plugin-dir', '/plug'],
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--plugin-dir', '/plug', '--', 'go']);
  });

  it('threads --name so the agent session matches the terminal display name', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      sessionName: 'Karst: PROJ-42 — Fix login',
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--name', 'Karst: PROJ-42 — Fix login', '--', 'go']);
  });

  it('sanitizes an unbounded ticket title before it reaches --name', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      sessionName: 'Karst: PROJ-42 — line one\nline two',
    });
    expect(cmd.args).toEqual(['--name', 'Karst: PROJ-42 — line one line two']);
  });

  it('omits --name when no session name is given (or it is blank)', () => {
    expect(adapter.buildInteractiveCommand({ cwd: '/wt' }).args).not.toContain('--name');
    expect(
      adapter.buildInteractiveCommand({ cwd: '/wt', sessionName: '  ' }).args,
    ).not.toContain('--name');
  });

  it('names a resumed session too, so a renamed ticket does not keep a stale label', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      resume: 'sess-1',
      sessionName: 'Karst: PROJ-42 — Fix login',
    });
    expect(cmd.args).toEqual([
      '--resume',
      'sess-1',
      '--name',
      'Karst: PROJ-42 — Fix login',
    ]);
  });

  it('threads --model when a model is given (before the positional seed)', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      model: 'claude-opus-4-8',
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--model', 'claude-opus-4-8', '--', 'go']);
  });

  it('omits --model when none is given', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' });
    expect(cmd.args).not.toContain('--model');
  });

  it('threads --effort when an effort is given', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      model: 'claude-opus-4-8',
      effort: 'high',
      initialPrompt: 'go',
    });
    expect(cmd.args).toEqual(['--model', 'claude-opus-4-8', '--effort', 'high', '--', 'go']);
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

  it('never claims or overwrites pre-existing repository plugin dirs', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    writeNeutral(baseDir, 'rpi', [
      { relPath: 'agents/research.md', body: '# generated research' },
    ]);

    // The repository checks in its own `.karst-plugin/rpi` and
    // `.karst-plugin/karst` trees — exactly the paths this adapter builds.
    const idPluginDir = join(sessionDir, '.karst-plugin', 'rpi');
    const karstDir = join(sessionDir, '.karst-plugin', 'karst');
    for (const [dir, relPath, body] of [
      [idPluginDir, join('agents', 'research.md'), 'repository research'],
      [idPluginDir, join('.claude-plugin', 'plugin.json'), '{"name":"repo"}'],
      [karstDir, join('commands', 'rpi.md'), 'repository command'],
    ] as const) {
      const dest = join(dir, relPath);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, body);
    }

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        artifacts: [{ kind: 'agent', relPath: 'agents/research.md' }],
        workflow: [{ name: 'plan' }],
      },
    });

    expect(readFileSync(join(idPluginDir, 'agents', 'research.md'), 'utf8')).toBe(
      'repository research',
    );
    expect(
      readFileSync(join(idPluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    ).toBe('{"name":"repo"}');
    expect(readFileSync(join(karstDir, 'commands', 'rpi.md'), 'utf8')).toBe(
      'repository command',
    );
    expect(result.ownedPaths).toEqual([]);
    // Still launched against the repository's own plugins.
    expect(result.extraArgs).toContain(idPluginDir);
    expect(result.extraArgs).toContain(karstDir);
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
    expect(body).toContain('# RPI');
    expect(result.invocation).toBe('/karst:rpi');
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

  it('threads cliPhasePrefix into the orchestrator so each phase step carries its own marker', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'rpi',
        label: 'RPI',
        workflow: [{ name: 'research', command: '/rpi:research' }, { name: 'plan' }],
      },
      cliPhasePrefix: (name) => `node "/ext/cli.js" phase ${name} --db "/x.db" --ticket`,
    });

    const body = readFileSync(
      join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md'),
      'utf8',
    );
    expect(body).toContain('$KARST phase research --db "/x.db" --ticket $ARGUMENTS');
    expect(body).toContain('$KARST phase plan --db "/x.db" --ticket $ARGUMENTS');
  });

  it('leaves the orchestrator free of phase markers when no cliPhasePrefix is given', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
    });

    const body = readFileSync(
      join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md'),
      'utf8',
    );
    expect(body).not.toContain('--ticket');
  });

  it('slugs a namespaced approach id into a legal /karst:<id> command name', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'superpowers:writing-plans',
        label: 'Write a plan first',
        workflow: [{ name: 'plan' }, { name: 'implement' }],
      },
    });

    expect(result.invocation).toBe('/karst:superpowers-writing-plans');
    const cmdPath = join(sessionDir, '.karst-plugin', 'karst', 'commands', 'superpowers-writing-plans.md');
    expect(existsSync(cmdPath)).toBe(true);
    const body = readFileSync(cmdPath, 'utf8');
    expect(body).toContain('# Write a plan first');
  });

  // The `karst` plugin dir is SHARED by every approach a worktree is ever
  // launched under: it is named for the plugin, not the approach. Skipping the
  // whole dir when it already existed meant a worktree first launched under
  // `rpi` and then re-launched under another approach never got the second
  // approach's command file written — while the seed still invoked it, so the
  // session opened with "Unknown command: /karst:<id>" (UNKNOWN-COMMAND-ISSUE,
  // observed AFTER the slug fix).
  it('writes the orchestrator into a karst plugin dir another approach already created', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();

    adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
    });
    const result = adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: {
        id: 'superpowers:writing-plans',
        label: 'Write a plan first',
        workflow: [{ name: 'plan' }],
      },
    });

    expect(result.invocation).toBe('/karst:superpowers-writing-plans');
    const cmdPath = join(
      sessionDir, '.karst-plugin', 'karst', 'commands', 'superpowers-writing-plans.md',
    );
    expect(readFileSync(cmdPath, 'utf8')).toContain('# Write a plan first');
    // the first approach's command is left in place — both are registered
    expect(existsSync(join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md'))).toBe(true);
  });

  // A relaunch at a later stage re-renders the same command with a different
  // marker step. The stale body named the stage the CLI would now refuse.
  it('re-renders an existing generated orchestrator with the current stage marker', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    const pkg = { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] };

    adapter.materializeApproach!({
      baseDir, sessionDir, pkg,
      cliStagePrefix: 'node "/ext/cli.js" stage impl pass',
    });
    adapter.materializeApproach!({
      baseDir, sessionDir, pkg,
      cliStagePrefix: 'node "/ext/cli.js" stage fix pass',
    });

    const body = readFileSync(
      join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md'),
      'utf8',
    );
    expect(body).toContain('stage fix pass');
    expect(body).not.toContain('stage impl pass');
  });

  // The property the old dir-level guard was protecting: a file the repository
  // checked in at the same path belongs to the repository, not this terminal.
  it('never overwrites a command file karst did not generate', () => {
    const baseDir = makeDir();
    const sessionDir = makeDir();
    const cmdPath = join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md');
    mkdirSync(dirname(cmdPath), { recursive: true });
    writeFileSync(cmdPath, 'checked into the repo');

    adapter.materializeApproach!({
      baseDir,
      sessionDir,
      pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
    });

    expect(readFileSync(cmdPath, 'utf8')).toBe('checked into the repo');
  });
});

describe('ClaudeAdapter.runHeadless', () => {
  it('forwards the abort signal into the headless spawn', async () => {
    let seenOpts: { signal?: AbortSignal } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    const controller = new AbortController();
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a', signal: controller.signal });
    expect(seenOpts?.signal).toBe(controller.signal);
  });

  it('forwards the headless deadline into the spawn', async () => {
    let seenOpts: { timeoutMs?: number } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    await new ClaudeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      timeoutMs: 345_678,
    });
    expect(seenOpts?.timeoutMs).toBe(345_678);
  });

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

  it('isolates the run from the operator\'s personal MCP/plugin config', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' });
    expect(seen.args).toContain('--strict-mcp-config');
    // `--mcp-config '{}'` is rejected by the CLI ("Invalid MCP configuration:
    // mcpServers: Invalid input"), so the isolation flag must travel alone.
    expect(seen.args).not.toContain('--mcp-config');
  });

  // SHIP-ADOPT-PR-WHEN-PUSH-NEVER §2: the reviewer prompt's leading `---` YAML
  // frontmatter was passed as -p's immediate value, and the CLI read it as an
  // unknown option ("error: unknown option '--- name: reviewer ...'"). The
  // prompt must always land as a positional after `--`, exactly like
  // buildInteractiveCommand already does.
  it('inserts -- before the prompt so a leading --- frontmatter never parses as an option', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    const prompt = '---\nname: reviewer\ndescription: find bugs\n---\nlook for bugs';
    await adapter.runHeadless({ prompt, cwd: '/wt/a' });
    const dashIndex = seen.args.indexOf('--');
    expect(dashIndex).toBeGreaterThanOrEqual(0);
    expect(seen.args[dashIndex + 1]).toBe(prompt);
    expect(seen.args[dashIndex + 2]).toBeUndefined();
  });

  it('passes --model when one is resolved so the run never falls back to the CLI default', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a', model: 'claude-sonnet-5' });
    expect(seen.args).toContain('--model');
    expect(seen.args[seen.args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('passes --effort as an individual argv value', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a', model: 'claude-opus-5', effort: 'high' });
    expect(seen.args).toContain('--effort');
    expect(seen.args[seen.args.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort when none is given', async () => {
    const seen: { args: string[] } = { args: [] };
    const spawn: SpawnHeadless = async (_cmd, args) => {
      seen.args = args;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    await new ClaudeAdapter(spawn).runHeadless({ prompt: 'go', cwd: '/wt/a' });
    expect(seen.args).not.toContain('--effort');
  });

  it('rejects on a nonzero exit code', async () => {
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: '', exitCode: 1, stderr: 'boom' }));
    await expect(adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' })).rejects.toThrow(/boom|exit/i);
  });

  it('renders a 429 envelope as a usage-limit sentence, not the raw JSON', async () => {
    const envelope = JSON.stringify({
      is_error: true,
      session_id: 'sess-9',
      api_error_status: 429,
      usage: { cache_read_input_tokens: 15912 },
      result:
        "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
    });
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: envelope, exitCode: 1 }));
    const error = await adapter
      .runHeadless({ prompt: 'go', cwd: '/wt/a' })
      .then(() => null, (e: Error) => e);
    expect(error?.message).toContain('Claude usage limit reached');
    expect(error?.message).toContain("You've hit your monthly spend limit");
    expect(error?.message).not.toContain('session_id');
    expect(error?.message).not.toContain('cache_read_input_tokens');
  });

  it('rejects when stdout is not valid JSON', async () => {
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: 'not json', exitCode: 0 }));
    await expect(adapter.runHeadless({ prompt: 'go', cwd: '/wt/a' })).rejects.toThrow(/JSON/i);
  });

  it('emits a spawn debug line with the prompt redacted to its length', async () => {
    const lines: string[] = [];
    const prompt = 'a very long ticket prompt nobody may see verbatim';
    const adapter = new ClaudeAdapter(
      fakeSpawn({ stdout: JSON.stringify({ session_id: 's', result: 'x' }), exitCode: 0 }),
    );
    await adapter.runHeadless({
      prompt,
      cwd: '/wt/a',
      debug: (m) => lines.push(m),
    });
    expect(lines.some((line) => line.startsWith('[agent:claude] spawn:'))).toBe(true);
    expect(lines[0]).toContain(`<prompt:${prompt.length} chars>`);
    expect(lines[0]).not.toContain('ticket prompt');
  });

  it('emits an exit debug line with bounded stdout/stderr on a nonzero exit', async () => {
    const lines: string[] = [];
    const adapter = new ClaudeAdapter(
      fakeSpawn({ stdout: 'x'.repeat(600), exitCode: 2, stderr: 'boom' }),
    );
    await expect(
      adapter.runHeadless({
        prompt: 'go',
        cwd: '/wt/a',
        debug: (m) => lines.push(m),
      }),
    ).rejects.toThrow();
    const exitLine = lines.find((line) => line.startsWith('[agent:claude] exit'));
    expect(exitLine).toContain('exit 2');
    expect(exitLine).toContain('boom');
    // The stdout preview is capped at 500 chars, never the full 600.
    expect(exitLine?.match(/stdout: x{500}…/)).not.toBeNull();
  });

  it('emits a debug line naming unparseable output, bounded', async () => {
    const lines: string[] = [];
    const adapter = new ClaudeAdapter(fakeSpawn({ stdout: 'not json', exitCode: 0 }));
    await expect(
      adapter.runHeadless({
        prompt: 'go',
        cwd: '/wt/a',
        debug: (m) => lines.push(m),
      }),
    ).rejects.toThrow(/JSON/i);
    expect(lines.some((line) => /\[agent:claude\] unparseable output/.test(line))).toBe(true);
  });

  it('forwards the debug callback into the headless spawn options', async () => {
    let seenOpts: { onDebug?: (m: string) => void } | undefined;
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      seenOpts = opts;
      return { stdout: JSON.stringify({ session_id: 's', result: 'x' }), stderr: '', exitCode: 0 };
    };
    const adapter = new ClaudeAdapter(spawn);
    const debug = (m: string): void => undefined as void;
    await adapter.runHeadless({ prompt: 'go', cwd: '/wt/a', debug });
    expect(seenOpts?.onDebug).toBe(debug);
  });

  it('emits only the readable result from the settled Claude envelope', async () => {
    const envelope = JSON.stringify({
      is_error: false,
      duration_api_ms: 114_882,
      session_id: 'ed2ecfaf-3677-4af2-a3e4-3b6b5559bbb4',
      usage: { input_tokens: 32, cache_read_input_tokens: 1_481_107 },
      result: '[\n  { "severity": "high", "title": "Readable finding" }\n]',
    });
    const spawn: SpawnHeadless = async () => ({ stdout: envelope, stderr: '', exitCode: 0 });
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];

    await new ClaudeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      onOutput: (chunk) => rendered.push(chunk),
    });

    expect(rendered).toEqual([
      {
        stream: 'stdout',
        text: '[\n  { "severity": "high", "title": "Readable finding" }\n]\n',
      },
    ]);
  });

  it('formats bounded settled stdout instead of retaining the raw live document stream', async () => {
    const envelope = JSON.stringify({
      is_error: false,
      session_id: 'bounded-session',
      result: 'Readable bounded result',
    });
    const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
      opts?.onOutput?.({ stream: 'stdout', text: 'x'.repeat(16 * 1024) });
      return { stdout: envelope, stderr: '', exitCode: 0 };
    };
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];

    await new ClaudeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      onOutput: (chunk) => rendered.push(chunk),
    });

    expect(rendered).toEqual([
      { stream: 'stdout', text: 'Readable bounded result\n' },
    ]);
  });

  it('streams stderr before settlement without replaying it when the spawn rejects', async () => {
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    let rejectSpawn: ((error: Error) => void) | undefined;
    const spawn: SpawnHeadless = (_cmd, _args, _cwd, opts) =>
      new Promise((_resolve, reject) => {
        rejectSpawn = reject;
        opts?.onOutput?.({ stream: 'stderr', text: 'provider failed before settlement\n' });
      });

    const run = new ClaudeAdapter(spawn).runHeadless({
      prompt: 'go',
      cwd: '/wt/a',
      onOutput: (chunk) => rendered.push(chunk),
    });

    await Promise.resolve();
    expect(rendered).toEqual([
      { stream: 'stderr', text: 'provider failed before settlement\n' },
    ]);

    rejectSpawn?.(new Error('spawn failed'));
    await expect(run).rejects.toThrow('spawn failed');
    expect(rendered).toEqual([
      { stream: 'stderr', text: 'provider failed before settlement\n' },
    ]);
  });

  it('emits a large settled result in UTF-8 byte-bounded console chunks', async () => {
    const result = '界'.repeat(50_000);
    const envelope = JSON.stringify({ session_id: 'large-result', result });
    const rendered: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];

    await new ClaudeAdapter(async () => ({ stdout: envelope, stderr: '', exitCode: 0 }))
      .runHeadless({
        prompt: 'go',
        cwd: '/wt/a',
        onOutput: (chunk) => rendered.push(chunk),
      });

    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.every((chunk) => Buffer.byteLength(chunk.text) <= 64 * 1024)).toBe(true);
    expect(rendered.map((chunk) => chunk.text).join('')).toBe(`${result}\n`);
  });
});
