import { describe, it, expect } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveCommandCwd } from './commandCwd.js';

describe('resolveCommandCwd', () => {
  it('leaves a bare name alone so PATH lookup still decides', () => {
    // `pytest`, `npm`, `go` — the whole point of a bare name is that the
    // machine's PATH answers it. Anchoring it to the worktree would break
    // every command gate that names an installed tool.
    expect(resolveCommandCwd('pytest', '/work/repo')).toBe('pytest');
    expect(resolveCommandCwd('npm', '/work/repo')).toBe('npm');
  });

  it('leaves an absolute path alone', () => {
    const abs = join('/opt', 'tools', 'lint');
    expect(resolveCommandCwd(abs, '/work/repo')).toBe(abs);
  });

  it('anchors a relative path to the gate cwd, not the extension host cwd', () => {
    // `.venv/bin/pytest` is Python's dominant layout. Node's spawn resolves a
    // relative program against the PARENT's cwd, never the child's `cwd`
    // option, so without this the venv gate is an ENOENT on every machine.
    const resolved = resolveCommandCwd('.venv/bin/pytest', join('/work', 'repo'));
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(resolve(join('/work', 'repo'), '.venv/bin/pytest'));
  });

  it('anchors a bare-relative path that walks upward', () => {
    expect(resolveCommandCwd('../tools/lint', join('/work', 'repo'))).toBe(
      resolve(join('/work', 'repo'), '../tools/lint'),
    );
  });

  it('anchors an explicit ./ path', () => {
    expect(resolveCommandCwd('./gradlew', join('/work', 'repo'))).toBe(
      resolve(join('/work', 'repo'), 'gradlew'),
    );
  });

  it('leaves an empty command alone rather than yielding the directory', () => {
    // `resolve('/work/repo', '')` is the directory itself — a spawnable-looking
    // string for an unspawnable gate. Pass it through so spawn's own error says
    // what is actually wrong.
    expect(resolveCommandCwd('', '/work/repo')).toBe('');
  });
});
