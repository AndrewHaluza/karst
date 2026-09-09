import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityAdapter, type SpawnHeadless } from './antigravity.js';

function fakeSpawn(result: { stdout: string; exitCode: number; stderr?: string }): SpawnHeadless {
  return async () => ({ stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode });
}

describe('AntigravityAdapter', () => {
  let tmpDir: string;
  const extraTmpDirs: string[] = [];

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    while (extraTmpDirs.length > 0) {
      rmSync(extraTmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  const getTmp = () => {
    if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'karst-agy-test-'));
    return tmpDir;
  };

  it('declares the correct binary and capabilities', () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.requiredBinary).toBe('agy');
    // The conversation watch (agyConversationWatch.ts) reads the CLI's
    // conversation DB: SessionStart from the discovered conversation id, and
    // permission.asked/UserPromptSubmit from a pending `status = 9` step.
    expect(adapter.capabilities.lifecycleEvents).toBe(true);
    // The watch captures the conversation id, and `agy --conversation <id>`
    // resumes it (verified against the installed CLI) — so resume is real.
    expect(adapter.capabilities.resume).toBe(true);
  });

  // Antigravity's interactive usage is measured by reading per-call token counts
  // from the conversation DB's steps.metadata (field-9 submessage), implemented
  // in agyUsageWatch.ts.
  it('advertises interactive usage — the conversation DB records per-call token counts', () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.capabilities.interactiveUsage).toBe(true);
  });

  describe('buildInteractiveCommand', () => {
    it('builds a basic command', () => {
      const adapter = new AntigravityAdapter();
      const cmd = adapter.buildInteractiveCommand({ cwd: '/test' });
      expect(cmd.command).toBe('agy');
      expect(cmd.args).toEqual([]);
    });

    it('passes resume and model', () => {
      const adapter = new AntigravityAdapter();
      const cmd = adapter.buildInteractiveCommand({
        cwd: '/test',
        resume: 'sesh-123',
        model: 'gemini-3.6-pro',
      });
      expect(cmd.args).toEqual(['--conversation', 'sesh-123', '--model', 'gemini-3.6-pro']);
    });

    it('passes an effort as --effort', () => {
      const adapter = new AntigravityAdapter();
      const cmd = adapter.buildInteractiveCommand({
        cwd: '/test',
        model: 'gemini-3.6-pro',
        effort: 'high',
      });
      expect(cmd.args).toEqual(['--model', 'gemini-3.6-pro', '--effort', 'high']);
    });

    it('passes an initial prompt', () => {
      const adapter = new AntigravityAdapter();
      const cmd = adapter.buildInteractiveCommand({
        cwd: '/test',
        initialPrompt: 'hello world',
      });
      expect(cmd.args).toEqual(['-i', 'hello world']);
    });

    it('appends extraArgs before the prompt', () => {
      const adapter = new AntigravityAdapter();
      const cmd = adapter.buildInteractiveCommand({
        cwd: '/test',
        initialPrompt: 'hello',
        extraArgs: ['--add-dir', '/tmp/foo'],
      });
      expect(cmd.args).toEqual(['--add-dir', '/tmp/foo', '-i', 'hello']);
    });
  });

  describe('runHeadless', () => {
    it('forwards the abort signal into the headless spawn', async () => {
      let seenOpts: { signal?: AbortSignal } | undefined;
      const spawner: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
        seenOpts = opts;
        return { stdout: 'success', stderr: '', exitCode: 0 };
      };
      const adapter = new AntigravityAdapter(spawner);
      const controller = new AbortController();
      await adapter.runHeadless({ prompt: 'do', cwd: '/test', signal: controller.signal });
      expect(seenOpts?.signal).toBe(controller.signal);
    });

    it('forwards the headless deadline into the spawn', async () => {
      let seenOpts: { timeoutMs?: number } | undefined;
      const spawner: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
        seenOpts = opts;
        return { stdout: 'success', stderr: '', exitCode: 0 };
      };
      await new AntigravityAdapter(spawner).runHeadless({
        prompt: 'do',
        cwd: '/test',
        timeoutMs: 456_789,
      });
      expect(seenOpts?.timeoutMs).toBe(456_789);
    });

    it('spawns agy -p and returns output', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'success', exitCode: 0 }));
      const adapter = new AntigravityAdapter(spawner);

      const result = await adapter.runHeadless({
        prompt: 'do the thing',
        cwd: '/test',
      });

      expect(spawner).toHaveBeenCalledWith('agy', ['-p', 'do the thing'], '/test', {
        signal: undefined,
      });
      expect(result.raw).toBe('success');
      expect(result.sessionId).toBe('');
    });

    it('passes an effort as --effort into the headless spawn', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'success', exitCode: 0 }));
      const adapter = new AntigravityAdapter(spawner);

      await adapter.runHeadless({
        prompt: 'do the thing',
        cwd: '/test',
        effort: 'high',
      });

      expect(spawner).toHaveBeenCalledWith(
        'agy',
        ['-p', 'do the thing', '--effort', 'high'],
        '/test',
        { signal: undefined },
      );
    });

    it('passes resume and permission mode', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'success', exitCode: 0 }));
      const adapter = new AntigravityAdapter(spawner);

      await adapter.runHeadless({
        prompt: 'do the thing',
        cwd: '/test',
        resume: 'sesh-123',
        permissionMode: 'bypassPermissions',
      });

      expect(spawner).toHaveBeenCalledWith(
        'agy',
        ['-p', 'do the thing', '--conversation', 'sesh-123', '--dangerously-skip-permissions'],
        '/test',
        { signal: undefined }
      );
    });

    it('rejects on nonzero exit code', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'fail', stderr: 'boom', exitCode: 1 }));
      const adapter = new AntigravityAdapter(spawner);

      await expect(
        adapter.runHeadless({ prompt: 'do', cwd: '/test' })
      ).rejects.toThrow(/Antigravity failed \(exit 1\): boom/);
    });

    it('names a usage limit instead of echoing the CLI failure', async () => {
      const spawner = vi.fn(
        fakeSpawn({
          stdout: '',
          stderr: 'Error: RESOURCE_EXHAUSTED: Quota exceeded for metric generate_requests',
          exitCode: 1,
        }),
      );
      const adapter = new AntigravityAdapter(spawner);

      await expect(
        adapter.runHeadless({ prompt: 'do', cwd: '/test' })
      ).rejects.toThrow(/Antigravity usage limit reached/);
    });

    it('emits debug lines at spawn, console-stream decision, and exit', async () => {
      const lines: string[] = [];
      const adapter = new AntigravityAdapter(
        fakeSpawn({ stdout: 'ok', exitCode: 0 }),
      );

      await adapter.runHeadless({
        prompt: 'do the thing',
        cwd: '/test',
        debug: (m) => lines.push(m),
      });

      expect(lines[0]).toMatch(/\[agent:antigravity\] spawn: -p <prompt:12 chars> \(cwd \/test\)/);
      expect(lines).toContainEqual(
        expect.stringMatching(/\[agent:antigravity\] console stream: none — no onOutput hook/),
      );
    });

    it('emits a console-stream debug line when an onOutput hook is present', async () => {
      const lines: string[] = [];
      const adapter = new AntigravityAdapter(fakeSpawn({ stdout: 'ok', exitCode: 0 }));

      await adapter.runHeadless({
        prompt: 'do',
        cwd: '/test',
        onOutput: () => {},
        debug: (m) => lines.push(m),
      });

      expect(lines).toContainEqual(
        expect.stringMatching(/\[agent:antigravity\] console stream: forwarding live chunks/),
      );
    });
  });

  describe('materializeApproach', () => {
    it('builds a discoverable workspace plugin and preserves neutral artifact structure', () => {
      const sessionDir = getTmp();
      const baseDir = mkdtempSync(join(tmpdir(), 'karst-agy-base-'));
      extraTmpDirs.push(baseDir);
      for (const file of [
        { relPath: 'agents/research.md', body: '# research' },
        { relPath: 'skills/writing-plans/SKILL.md', body: '# plans' },
        { relPath: 'commands/plan.md', body: '# plan command' },
      ]) {
        const path = join(baseDir, 'rpi', file.relPath);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, file.body);
      }

      const res = new AntigravityAdapter().materializeApproach({
        pkg: {
          id: 'rpi',
          label: 'RPI',
          artifacts: [
            { kind: 'agent', relPath: 'agents/research.md' },
            { kind: 'skill', relPath: 'skills/writing-plans/SKILL.md' },
            { kind: 'command', relPath: 'commands/plan.md' },
          ],
        },
        baseDir,
        sessionDir,
      });

      const pluginDir = join(sessionDir, '.agents', 'plugins', 'rpi');
      expect(res.extraArgs).toEqual([]);
      expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toEqual({
        name: 'rpi',
      });
      expect(readFileSync(join(pluginDir, 'agents', 'research.md'), 'utf8')).toBe('# research');
      expect(readFileSync(join(pluginDir, 'skills', 'writing-plans', 'SKILL.md'), 'utf8')).toBe(
        '# plans',
      );
      const commandSkill = readFileSync(join(pluginDir, 'skills', 'plan', 'SKILL.md'), 'utf8');
      expect(commandSkill).toContain('name: plan');
      expect(commandSkill).toContain('# plan command');
      expect(existsSync(join(pluginDir, 'commands', 'plan.md'))).toBe(false);
    });

    it('never claims or overwrites pre-existing repository plugin dirs', () => {
      const sessionDir = getTmp();
      const baseDir = mkdtempSync(join(tmpdir(), 'karst-agy-base-'));
      extraTmpDirs.push(baseDir);
      const source = join(baseDir, 'rpi', 'agents', 'research.md');
      mkdirSync(join(source, '..'), { recursive: true });
      writeFileSync(source, '# generated research');

      const pluginDir = join(sessionDir, '.agents', 'plugins', 'rpi');
      const karstDir = join(sessionDir, '.agents', 'plugins', 'karst');
      for (const [dir, relPath, body] of [
        [pluginDir, join('agents', 'research.md'), 'repository research'],
        [pluginDir, 'plugin.json', '{"name":"repo"}'],
        [karstDir, join('skills', 'rpi', 'SKILL.md'), 'repository skill'],
      ] as const) {
        const dest = join(dir, relPath);
        mkdirSync(join(dest, '..'), { recursive: true });
        writeFileSync(dest, body);
      }

      const res = new AntigravityAdapter().materializeApproach({
        pkg: {
          id: 'rpi',
          label: 'RPI',
          artifacts: [{ kind: 'agent', relPath: 'agents/research.md' }],
          workflow: [{ name: 'plan' }],
        },
        baseDir,
        sessionDir,
      });

      expect(readFileSync(join(pluginDir, 'agents', 'research.md'), 'utf8')).toBe(
        'repository research',
      );
      expect(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')).toBe('{"name":"repo"}');
      expect(readFileSync(join(karstDir, 'skills', 'rpi', 'SKILL.md'), 'utf8')).toBe(
        'repository skill',
      );
      expect(res.ownedPaths).toEqual([]);
    });

    it('returns empty extraArgs for an empty package', () => {
      const adapter = new AntigravityAdapter();
      const res = adapter.materializeApproach({
        pkg: { id: 'foo', label: 'Foo' },
        baseDir: '/base',
        sessionDir: '/sess',
      });
      expect(res.extraArgs).toEqual([]);
    });

    it('throws on reserved karst plugin name', () => {
      const adapter = new AntigravityAdapter();
      expect(() => {
        adapter.materializeApproach({
          pkg: { id: 'karst', label: 'Karst', workflow: [{ name: 'w' }] },
          baseDir: '/base',
          sessionDir: '/sess',
        });
      }).toThrow(/reserved/);
    });

    it('writes a soloAgent into the sessionDir', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();
      const res = adapter.materializeApproach({
        pkg: { id: 'test-approach', label: 'Test' },
        baseDir: '/base',
        sessionDir: dir,
        soloAgent: { name: 'helper', body: '# helper' },
      });

      expect(res.extraArgs).toEqual([]);
      expect(existsSync(join(dir, '.agents', 'plugins', 'test-approach', 'agents', 'helper.md'))).toBe(true);
      expect(readFileSync(join(dir, '.agents', 'plugins', 'test-approach', 'agents', 'helper.md'), 'utf8')).toBe('# helper');
    });

    it('writes a generated workflow orchestrator', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();
      const res = adapter.materializeApproach({
        pkg: {
          id: 'do-it',
          label: 'Do It',
          workflow: [{ name: 'step1', command: '/do-it:step1' }],
        },
        baseDir: '/base',
        sessionDir: dir,
      });

      expect(res.extraArgs).toEqual([]);
      expect(existsSync(join(dir, '.agents', 'plugins', 'karst', 'skills', 'do-it', 'SKILL.md'))).toBe(true);
      const body = readFileSync(
        join(dir, '.agents', 'plugins', 'karst', 'skills', 'do-it', 'SKILL.md'),
        'utf8',
      );
      expect(body).toContain('name: do-it');
      expect(body).toContain('# Do It');
      expect(res.invocation).toBe('$do-it');
      expect(body).toContain('**step1**');
    });

    it('slugs a namespaced approach id into a legal workflow skill name', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();
      const res = adapter.materializeApproach({
        pkg: {
          id: 'superpowers:writing-plans',
          label: 'Write a plan first',
          workflow: [{ name: 'plan' }, { name: 'implement' }],
        },
        baseDir: '/base',
        sessionDir: dir,
      });

      expect(res.invocation).toBe('$superpowers-writing-plans');
      const skillDir = join(dir, '.agents', 'plugins', 'karst', 'skills', 'superpowers-writing-plans');
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
      expect(body).toContain('name: superpowers-writing-plans');
    });

    // The `karst` plugin dir is shared by every approach a worktree is ever
    // launched under. Skipping it wholesale when it existed left a re-launch
    // under a second approach with no skill for the invocation the seed named
    // (UNKNOWN-COMMAND-ISSUE, observed after the slug fix).
    it('writes the workflow skill into a karst plugin dir another approach already created', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();
      adapter.materializeApproach({
        pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
        baseDir: '/base',
        sessionDir: dir,
      });
      const res = adapter.materializeApproach({
        pkg: {
          id: 'superpowers:writing-plans',
          label: 'Write a plan first',
          workflow: [{ name: 'plan' }],
        },
        baseDir: '/base',
        sessionDir: dir,
      });

      expect(res.invocation).toBe('$superpowers-writing-plans');
      const skillPath = join(
        dir, '.agents', 'plugins', 'karst', 'skills', 'superpowers-writing-plans', 'SKILL.md',
      );
      expect(readFileSync(skillPath, 'utf8')).toContain('# Write a plan first');
      const first = join(dir, '.agents', 'plugins', 'karst', 'skills', 'rpi', 'SKILL.md');
      expect(existsSync(first)).toBe(true);
    });

    it('re-renders an existing generated workflow skill with the current stage marker', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();
      const pkg = { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] };
      adapter.materializeApproach({
        pkg, baseDir: '/base', sessionDir: dir,
        cliStagePrefix: 'node "/ext/cli.js" stage impl pass',
      });
      adapter.materializeApproach({
        pkg, baseDir: '/base', sessionDir: dir,
        cliStagePrefix: 'node "/ext/cli.js" stage fix pass',
      });

      const body = readFileSync(
        join(dir, '.agents', 'plugins', 'karst', 'skills', 'rpi', 'SKILL.md'),
        'utf8',
      );
      expect(body).toContain('stage fix pass');
      expect(body).not.toContain('stage impl pass');
    });

    it('never overwrites a workflow skill karst did not generate', () => {
      const dir = getTmp();
      const skillPath = join(dir, '.agents', 'plugins', 'karst', 'skills', 'rpi', 'SKILL.md');
      mkdirSync(join(dir, '.agents', 'plugins', 'karst', 'skills', 'rpi'), { recursive: true });
      writeFileSync(skillPath, 'checked into the repo');

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
        baseDir: '/base',
        sessionDir: dir,
      });

      expect(readFileSync(skillPath, 'utf8')).toBe('checked into the repo');
    });

    it('bare direct + cliContextPrefix writes start-task.md and returns startTaskInvocation', () => {
      const dir = getTmp();

      const res = new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
      });

      const startTaskPath = join(dir, '.agents', 'plugins', 'karst', 'commands', 'start-task.md');
      expect(existsSync(startTaskPath)).toBe(true);
      const body = readFileSync(startTaskPath, 'utf8');
      expect(body).toContain('---');
      expect(body).toContain('description:');
      expect(body).toContain('argument-hint:');
      expect(body).toContain('node "/ext/cli.js" context --db "/x.db"');
      expect(res.startTaskInvocation).toBe('/karst:start-task');
    });

    it('bare direct without cliContextPrefix returns empty and no startTaskInvocation', () => {
      const adapter = new AntigravityAdapter();
      const res = adapter.materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: '/sess',
      });
      expect(res.extraArgs).toEqual([]);
      expect(res.startTaskInvocation).toBeUndefined();
    });

    it('an approach id colliding with any reserved basename throws', () => {
      const adapter = new AntigravityAdapter();
      expect(() => {
        adapter.materializeApproach({
          pkg: { id: 'start-task', label: 'Start Task' },
          baseDir: '/base',
          sessionDir: '/sess',
          cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        });
      }).toThrow(/reserved.*start-task/);
    });

    it('a workflow launch returns both invocation and startTaskInvocation', () => {
      const dir = getTmp();

      const res = new AntigravityAdapter().materializeApproach({
        pkg: {
          id: 'rpi',
          label: 'RPI',
          workflow: [{ name: 'research' }],
        },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
      });

      expect(res.invocation).toBe('$rpi');
      expect(res.startTaskInvocation).toBe('/karst:start-task');
    });

    it('second materializeApproach call does not re-claim owned paths', () => {
      const dir = getTmp();
      const adapter = new AntigravityAdapter();

      const first = adapter.materializeApproach({
        pkg: { id: 'rpi', label: 'RPI', workflow: [{ name: 'research' }] },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
      });
      const firstOwned = [...first.ownedPaths];

      const second = adapter.materializeApproach({
        pkg: {
          id: 'superpowers:writing-plans',
          label: 'Write a plan first',
          workflow: [{ name: 'plan' }],
        },
        baseDir: '/base',
        sessionDir: dir,
      });

      expect(second.ownedPaths).not.toContain(
        join(dir, '.agents', 'plugins', 'karst'),
      );
      expect(second.ownedPaths).not.toContain(
        join(dir, '.agents', 'plugins', 'rpi'),
      );
      expect(firstOwned.length).toBeGreaterThan(0);
    });

    it('(a) with all four prefixes, four command files exist in karst/commands', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        cliFixBriefPrefix: 'node "/ext/cli.js" fix-brief',
        cliConflictBriefPrefix: 'node "/ext/cli.js" conflict-brief',
      });

      const commandsDir = join(dir, '.agents', 'plugins', 'karst', 'commands');
      for (const basename of ['start-task', 'resume', 'fix', 'resolve-conflict']) {
        const filePath = join(commandsDir, `${basename}.md`);
        expect(existsSync(filePath), `${basename}.md should exist`).toBe(true);
      }
    });

    it('(b) with only cliContextPrefix, exactly two command files exist and neither is fix nor resolve-conflict', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
      });

      const commandsDir = join(dir, '.agents', 'plugins', 'karst', 'commands');
      expect(existsSync(join(commandsDir, 'start-task.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'resume.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'fix.md'))).toBe(false);
      expect(existsSync(join(commandsDir, 'resolve-conflict.md'))).toBe(false);
    });

    it('(c) an approach id colliding with any reserved basename throws', () => {
      for (const reserved of ['start-task', 'resume', 'fix', 'resolve-conflict']) {
        expect(() =>
          new AntigravityAdapter().materializeApproach({
            pkg: { id: reserved, label: reserved },
            baseDir: '/base',
            sessionDir: getTmp(),
            cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
          }),
        ).toThrow(/reserved|collides/);
      }
    });

    it('(d) the fix command body references the fix-brief prefix', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        cliFixBriefPrefix: 'node "/ext/cli.js" fix-brief',
      });

      const fixPath = join(dir, '.agents', 'plugins', 'karst', 'commands', 'fix.md');
      expect(existsSync(fixPath)).toBe(true);
      const body = readFileSync(fixPath, 'utf8');
      expect(body).toContain('node "/ext/cli.js" fix-brief');
    });

    it('(e) the resolve-conflict command body references the conflict-brief prefix', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        cliConflictBriefPrefix: 'node "/ext/cli.js" conflict-brief',
      });

      const resolvePath = join(dir, '.agents', 'plugins', 'karst', 'commands', 'resolve-conflict.md');
      expect(existsSync(resolvePath)).toBe(true);
      const body = readFileSync(resolvePath, 'utf8');
      expect(body).toContain('node "/ext/cli.js" conflict-brief');
    });

    it('(alias-a) two alias tickets and all four prefixes yield six alias files plus four generic', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        cliFixBriefPrefix: 'node "/ext/cli.js" fix-brief',
        cliConflictBriefPrefix: 'node "/ext/cli.js" conflict-brief',
        aliasTickets: [
          { key: 'PROJ-1', stageCurrent: 'impl' },
          { key: 'PROJ-2', stageCurrent: 'uat' },
        ],
      });

      const commandsDir = join(dir, '.agents', 'plugins', 'karst', 'commands');
      // Generic four
      for (const basename of ['start-task', 'resume', 'fix', 'resolve-conflict']) {
        expect(existsSync(join(commandsDir, `${basename}.md`)), `${basename}.md`).toBe(true);
      }
      // Alias six: 3 commands × 2 tickets
      for (const key of ['PROJ-1', 'PROJ-2']) {
        for (const basename of ['resume', 'fix', 'resolve-conflict']) {
          expect(existsSync(join(commandsDir, `${basename}-${key}.md`)), `${basename}-${key}.md`).toBe(true);
        }
      }
      // No start-task alias
      for (const key of ['PROJ-1', 'PROJ-2']) {
        expect(existsSync(join(commandsDir, `start-task-${key}.md`))).toBe(false);
      }
    });

    it('(alias-b) an alias body contains the literal ticket key and no $ARGUMENTS', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        aliasTickets: [{ key: 'PROJ-1', stageCurrent: 'impl' }],
      });

      const body = readFileSync(
        join(dir, '.agents', 'plugins', 'karst', 'commands', 'resume-PROJ-1.md'),
        'utf8',
      );
      expect(body).toContain('PROJ-1');
      expect(body).not.toContain('$ARGUMENTS');
      expect(body).toContain('This command is for ticket `PROJ-1`');
    });

    it('(alias-c) no start-task-<KEY> file is written', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        aliasTickets: [{ key: 'PROJ-1', stageCurrent: 'impl' }],
      });

      expect(existsSync(join(dir, '.agents', 'plugins', 'karst', 'commands', 'start-task-PROJ-1.md'))).toBe(false);
    });

    it('(alias-d) alias files are owned on first creation', () => {
      const dir = getTmp();

      const result = new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        aliasTickets: [
          { key: 'PROJ-1', stageCurrent: 'impl' },
          { key: 'PROJ-2', stageCurrent: 'uat' },
        ],
      });

      // The karst plugin dir is in ownedPaths (created for the generic commands).
      expect(result.ownedPaths).toContain(join(dir, '.agents', 'plugins', 'karst'));
    });

    it('(alias-e) an empty aliasTickets writes only the generic four', () => {
      const dir = getTmp();

      new AntigravityAdapter().materializeApproach({
        pkg: { id: 'bare', label: 'Bare' },
        baseDir: '/base',
        sessionDir: dir,
        cliContextPrefix: 'node "/ext/cli.js" context --db "/x.db"',
        cliFixBriefPrefix: 'node "/ext/cli.js" fix-brief',
        cliConflictBriefPrefix: 'node "/ext/cli.js" conflict-brief',
        aliasTickets: [],
      });

      const commandsDir = join(dir, '.agents', 'plugins', 'karst', 'commands');
      for (const basename of ['start-task', 'resume', 'fix', 'resolve-conflict']) {
        expect(existsSync(join(commandsDir, `${basename}.md`)), `${basename}.md`).toBe(true);
      }
      const { readdirSync } = require('node:fs');
      const files = readdirSync(commandsDir) as string[];
      expect(files.filter((f: string) => f.includes('PROJ'))).toHaveLength(0);
    });
  });
});
