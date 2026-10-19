import { describe, it, expect } from 'vitest';
import { BUILD_TOOLS, buildToolsRepair, missingBuildTools } from './nativeToolchain.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A PATH holding only the named binaries (each an empty executable file). */
function pathWith(...binaries) {
  const dir = mkdtempSync(join(tmpdir(), 'karst-toolchain-'));
  for (const binary of binaries) {
    const file = join(dir, binary);
    writeFileSync(file, '');
    // eslint-disable-next-line no-unused-expressions
    file;
  }
  return dir;
}

describe('missingBuildTools', () => {
  it('reports nothing missing when every tool is on PATH', () => {
    const dir = pathWith('python3', 'make', 'cc');
    expect(missingBuildTools(dir, 'linux')).toEqual([]);
  });

  it('names python3 when only the interpreter is missing', () => {
    const dir = pathWith('make', 'cc');
    expect(missingBuildTools(dir, 'linux')).toEqual(['python3']);
  });

  it('accepts "python" as the interpreter', () => {
    const dir = pathWith('python', 'make', 'cc');
    expect(missingBuildTools(dir, 'linux')).toEqual([]);
  });

  it('names the compiler when only g++ is present', () => {
    const dir = pathWith('python3', 'make', 'g++');
    expect(missingBuildTools(dir, 'linux')).toEqual([]);
  });

  it('names every missing tool on an empty PATH', () => {
    expect(missingBuildTools('', 'linux')).toEqual(['python3', 'make', 'a C++ compiler']);
  });

  it('covers exactly the tools a node-gyp source build needs', () => {
    expect(BUILD_TOOLS.map((t) => t.id)).toEqual(['python', 'make', 'compiler']);
  });
});

describe('buildToolsRepair', () => {
  it('is empty when nothing is missing', () => {
    expect(buildToolsRepair([])).toBe('');
  });

  it('names the missing tools and the repair', () => {
    const repair = buildToolsRepair(['python3', 'a C++ compiler']);
    expect(repair).toContain('python3');
    expect(repair).toContain('a C++ compiler');
    expect(repair).toContain('build-essential');
    expect(repair).toContain('python3');
  });
});
