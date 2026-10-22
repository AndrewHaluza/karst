import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import { baseDefinesScript, deriveNpmScript } from './npmScript.js';

describe('deriveNpmScript', () => {
  it('skips -s and reads the name before the -- passthrough', () => {
    expect(deriveNpmScript('npm', ['run', '-s', 'docs:graph', '--', '--check'])).toBe('docs:graph');
  });
  it('reads pnpm run x', () => {
    expect(deriveNpmScript('pnpm', ['run', 'x'])).toBe('x');
  });
  it('ignores --if-present', () => {
    expect(deriveNpmScript('npm', ['run', '--if-present', 'x'])).toBeNull();
  });
  it('skips the value of a value-taking flag instead of reading it as the script', () => {
    expect(deriveNpmScript('npm', ['run', '--loglevel', 'warn', 'x'])).toBe('x');
    expect(deriveNpmScript('npm', ['run', '--loglevel=warn', 'x'])).toBe('x');
    expect(deriveNpmScript('npm', ['run', '--registry', 'https://r.example', 'x'])).toBe('x');
  });
  it('derives nothing when a flag retargets another package', () => {
    expect(deriveNpmScript('npm', ['run', '-w', 'web', 'build'])).toBeNull();
    expect(deriveNpmScript('npm', ['run', '--workspace=web', 'build'])).toBeNull();
    expect(deriveNpmScript('npm', ['run', '--prefix', 'web', 'build'])).toBeNull();
    expect(deriveNpmScript('pnpm', ['--dir', 'web', 'run', 'build'])).toBeNull();
    expect(deriveNpmScript('pnpm', ['run', '-d', 'web', 'build'])).toBeNull();
  });
  it('derives nothing for yarn, whose run also launches bins', () => {
    expect(deriveNpmScript('yarn', ['run', 'tsc'])).toBeNull();
  });
  it('ignores non-run commands and other binaries', () => {
    expect(deriveNpmScript('npm', ['test'])).toBeNull();
    expect(deriveNpmScript('go', ['run', 'x'])).toBeNull();
    expect(deriveNpmScript('npm', ['run', '--'])).toBeNull();
  });
});

describe('baseDefinesScript', () => {
  const git = (exitCode: number, stdout: string): GitRunner => async () => ({ exitCode, stdout, stderr: '' });
  it('is true when the base package.json has the script', async () => {
    expect(await baseDefinesScript(git(0, '{"scripts":{"a":"x"}}'), '/w', 'develop', 'a')).toBe(true);
  });
  it('is false when absent, unreadable or malformed', async () => {
    expect(await baseDefinesScript(git(0, '{"scripts":{}}'), '/w', 'develop', 'a')).toBe(false);
    expect(await baseDefinesScript(git(128, ''), '/w', 'develop', 'a')).toBe(false);
    expect(await baseDefinesScript(git(0, 'nope'), '/w', 'develop', 'a')).toBe(false);
  });
});
