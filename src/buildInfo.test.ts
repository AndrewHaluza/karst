import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBuildInfo, readBuildInfo } from './buildInfo.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-build-info-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readBuildInfo', () => {
  it('reads a well-formed dist/build-info.json', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'build-info.json'),
      JSON.stringify({ commit8: 'abc12345', dirty: true, builtAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(readBuildInfo(dir)).toEqual({
      commit8: 'abc12345',
      dirty: true,
      builtAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns undefined when the stamp is absent (a plain dev build)', () => {
    expect(readBuildInfo(tempDir())).toBeUndefined();
  });

  it('returns undefined when the stamp is malformed', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'build-info.json'), '{not json');
    expect(readBuildInfo(dir)).toBeUndefined();
  });

  it('rejects a stamp missing the fields it logs', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ commit8: 'abc12345' }));
    expect(readBuildInfo(dir)).toBeUndefined();
  });

  it('defaults a missing dirty flag to false', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'build-info.json'),
      JSON.stringify({ commit8: 'abc12345', builtAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(readBuildInfo(dir)?.dirty).toBe(false);
  });
});

describe('describeBuildInfo', () => {
  it('names a dev build when no stamp is present', () => {
    expect(describeBuildInfo(undefined)).toBe('build: dev (no build-info.json)');
  });

  it('marks a dirty build', () => {
    expect(
      describeBuildInfo({ commit8: 'abc12345', dirty: true, builtAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe('build: abc12345-dirty built 2026-01-01T00:00:00.000Z');
  });

  it('leaves a clean build unmarked', () => {
    expect(
      describeBuildInfo({ commit8: 'abc12345', dirty: false, builtAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe('build: abc12345 built 2026-01-01T00:00:00.000Z');
  });
});
