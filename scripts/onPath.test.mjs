import { describe, it, expect } from 'vitest';
import { binaryNames, hasBinary } from './onPath.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function pathWith(...binaries) {
  const dir = mkdtempSync(join(tmpdir(), 'karst-onpath-'));
  for (const binary of binaries) writeFileSync(join(dir, binary), '');
  return dir;
}

describe('binaryNames', () => {
  it('is the bare name on POSIX', () => {
    expect(binaryNames('make', 'linux')).toEqual(['make']);
  });

  it('carries the Windows suffixes, the bare name last', () => {
    expect(binaryNames('docker', 'win32')).toEqual(['docker.exe', 'docker.cmd', 'docker.bat', 'docker']);
  });
});

describe('hasBinary', () => {
  it('is false on an empty PATH', () => {
    expect(hasBinary('docker', '', 'linux')).toBe(false);
  });

  it('is true when the binary is on PATH', () => {
    expect(hasBinary('docker', pathWith('docker'), 'linux')).toBe(true);
  });

  it('finds a Windows binary by its .exe name', () => {
    expect(hasBinary('docker', pathWith('docker.exe'), 'win32')).toBe(true);
  });

  it('does not claim a Windows binary on POSIX', () => {
    expect(hasBinary('docker', pathWith('docker.exe'), 'linux')).toBe(false);
  });
});
