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
    expect(adapter.capabilities.httpHooks).toBe(false);
    expect(adapter.capabilities.resume).toBe(false);
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
    it('spawns agy -p and returns output', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'success', exitCode: 0 }));
      const adapter = new AntigravityAdapter(spawner);

      const result = await adapter.runHeadless({
        prompt: 'do the thing',
        cwd: '/test',
      });

      expect(spawner).toHaveBeenCalledWith('agy', ['-p', 'do the thing'], '/test');
      expect(result.raw).toBe('success');
      expect(result.sessionId).toBe('');
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
        '/test'
      );
    });

    it('rejects on nonzero exit code', async () => {
      const spawner = vi.fn(fakeSpawn({ stdout: 'fail', stderr: 'boom', exitCode: 1 }));
      const adapter = new AntigravityAdapter(spawner);

      await expect(
        adapter.runHeadless({ prompt: 'do', cwd: '/test' })
      ).rejects.toThrow(/agy exited 1: boom/);
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
      expect(body).toContain('# /karst:do-it — Do It');
      expect(body).toContain('**step1**');
    });
  });
});
