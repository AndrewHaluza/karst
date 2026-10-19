import { describe, it, expect } from 'vitest';
import { dockerArgv, hasDocker, missingDockerMessage, EXIT_COMMAND_NOT_FOUND } from './dockerGate.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function pathWith(...binaries) {
  const dir = mkdtempSync(join(tmpdir(), 'karst-docker-'));
  for (const binary of binaries) writeFileSync(join(dir, binary), '');
  return dir;
}

describe('hasDocker', () => {
  it('is false on an empty PATH', () => {
    expect(hasDocker('')).toBe(false);
  });

  it('is true when docker is on PATH', () => {
    expect(hasDocker(pathWith('docker'))).toBe(true);
  });
});

describe('dockerArgv', () => {
  it('replaces the repo placeholder with the working directory', () => {
    expect(dockerArgv(['run', '-v', '{repo}:/work', 'img'], '/repo')).toEqual([
      'run',
      '-v',
      '/repo:/work',
      'img',
    ]);
  });

  it('replaces every occurrence in one argument', () => {
    expect(dockerArgv(['-v', '{repo}:{repo}'], '/repo')).toEqual(['-v', '/repo:/repo']);
  });

  it('leaves arguments without the placeholder untouched', () => {
    expect(dockerArgv(['run', '--rm'], '/repo')).toEqual(['run', '--rm']);
  });
});

describe('missingDockerMessage', () => {
  it('names the gate, the capability and the repair', () => {
    const message = missingDockerMessage('test:visual:docker');
    expect(message).toContain('test:visual:docker');
    expect(message).toContain('docker');
    expect(message).toContain('sandbox');
  });
});

describe('the missing-docker exit code', () => {
  it('is the POSIX "command not found" code, so a caller can tell it from a failed test', () => {
    expect(EXIT_COMMAND_NOT_FOUND).toBe(127);
  });
});
