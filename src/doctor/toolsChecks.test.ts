import { describe, it, expect } from 'vitest';
import {
  GH_DEPENDENCY,
  GIT_DEPENDENCY,
  NPM_DEPENDENCY,
  dependencyRegistry,
  renderMissingDependency,
} from '../runtime/deps.js';
import { MIN_VERSIONS, checkTools, type ToolsProbes } from './toolsChecks.js';

const allPresent = () => true;
const allReady = () => true;
const versions =
  (map: Record<string, string | undefined>) =>
  (binary: string): string | undefined =>
    map[binary];

function probesFor(over: Partial<ToolsProbes> = {}): ToolsProbes {
  return {
    registry: [GIT_DEPENDENCY, NPM_DEPENDENCY, GH_DEPENDENCY],
    probe: allPresent,
    ready: allReady,
    version: versions({ git: '2.43.0', npm: '10.2.0', gh: '2.50.0' }),
    ...over,
  };
}

function checkById(checks: ReturnType<typeof checkTools>, id: string) {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('checkTools', () => {
  it('reports every registry tool ok with its version when all are present and new enough', () => {
    const checks = checkTools(probesFor());

    expect(checks.map((c) => c.id)).toEqual(['tools.git', 'tools.npm', 'tools.gh']);
    expect(checks.every((c) => c.area === 'tools')).toBe(true);
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    expect(checkById(checks, 'tools.git').detail).toBe('git 2.43.0');
    expect(checkById(checks, 'tools.git').fix).toBeUndefined();
  });

  it('fails a missing tool with the install guidance as a consented fix', () => {
    const checks = checkTools(
      probesFor({ probe: (binary) => binary !== 'npm' }),
    );
    const npm = checkById(checks, 'tools.npm');

    expect(npm.status).toBe('fail');
    expect(npm.area).toBe('tools');
    expect(npm.detail).toBe(renderMissingDependency(NPM_DEPENDENCY));
    expect(npm.fix).toEqual({
      tier: 'consented',
      summary: 'Install npm',
      command: NPM_DEPENDENCY.install,
    });
  });

  it('fails a present but not-ready tool (gh not signed in) as a report-only fix', () => {
    const checks = checkTools(
      probesFor({ ready: (binary) => binary !== 'gh' }),
    );
    const gh = checkById(checks, 'tools.gh');

    expect(gh.status).toBe('fail');
    expect(gh.detail).toContain('not signed in');
    expect(gh.fix).toEqual({
      tier: 'report',
      summary: 'Make the GitHub CLI usable',
      nextStep: GH_DEPENDENCY.ready?.fix,
    });
  });

  it('warns when a tool is older than its minimum version, with a consented upgrade', () => {
    const checks = checkTools(
      probesFor({ version: versions({ git: '2.10.0', npm: '10.2.0', gh: '2.50.0' }) }),
    );
    const git = checkById(checks, 'tools.git');

    expect(git.status).toBe('warn');
    expect(git.detail).toContain('2.10.0');
    expect(git.fix?.tier).toBe('consented');
    expect(git.fix && 'command' in git.fix ? git.fix.command : '').toContain(MIN_VERSIONS.git);
  });

  it('treats an unparseable version string as ok, with a plain installed detail', () => {
    const checks = checkTools(
      probesFor({ version: versions({ git: 'git version unknown', npm: '10.2.0', gh: '2.50.0' }) }),
    );
    const git = checkById(checks, 'tools.git');

    expect(git.status).toBe('ok');
    expect(git.detail).toBe('git is installed');
  });

  it('treats a missing version as ok when the tool has no minimum', () => {
    const checks = checkTools(probesFor({ version: () => undefined }));
    const npm = checkById(checks, 'tools.npm');

    expect(npm.status).toBe('ok');
    expect(npm.detail).toBe('npm is installed');
  });

  it('compares versions numerically, not lexically, and treats missing parts as zero', () => {
    const at = (v: string) =>
      checkById(
        checkTools(probesFor({ version: versions({ git: v, npm: '10.2.0', gh: '2.50.0' }) })),
        'tools.git',
      ).status;

    expect(at('2.15')).toBe('ok');
    expect(at('2.15.0')).toBe('ok');
    expect(at('2.14.9')).toBe('warn');
    expect(at('10.0.0')).toBe('ok');
  });

  it('forwards the readOutput probe so output-validated tools are judged by it', () => {
    const readyOutput = dependencyRegistry('claude')[3];
    if (!readyOutput) throw new Error('expected agent dependency');
    const outputDep = {
      ...readyOutput,
      binary: 'fakeagent',
      ready: { args: ['--version'], fix: 'Install the right build.' },
      readyOutput: (stdout: string) => stdout.includes('OK'),
    };

    const ok = checkTools({
      registry: [outputDep],
      probe: allPresent,
      ready: allReady,
      readOutput: () => ({ stdout: 'OK 1.0', exitCode: 0 }),
      version: () => undefined,
    });
    const bad = checkTools({
      registry: [outputDep],
      probe: allPresent,
      ready: allReady,
      readOutput: () => ({ stdout: 'nope', exitCode: 0 }),
      version: () => undefined,
    });

    expect(ok[0]?.status).toBe('ok');
    expect(bad[0]?.status).toBe('fail');
  });

  it('emits one tools.<binary> check per registry entry, using the real registry', () => {
    const checks = checkTools({
      registry: dependencyRegistry('claude'),
      probe: allPresent,
      ready: allReady,
      version: () => undefined,
    });

    expect(checks.map((c) => c.id)).toEqual(['tools.git', 'tools.npm', 'tools.gh', 'tools.claude']);
    expect(new Set(checks.map((c) => c.area))).toEqual(new Set(['tools']));
  });
});
