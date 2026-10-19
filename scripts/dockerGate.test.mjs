import { describe, it, expect } from 'vitest';
import {
  BASELINE_ENV_MARKER,
  dockerArgv,
  envFromDockerArgs,
  EXIT_COMMAND_NOT_FOUND,
  gatePlan,
  hasDocker,
  isBaselineEnvironment,
  missingDockerMessage,
  readLocalCommand,
} from './dockerGate.mjs';
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
    expect(hasDocker('', 'linux')).toBe(false);
  });

  it('is true when docker is on PATH', () => {
    expect(hasDocker(pathWith('docker'), 'linux')).toBe(true);
  });
});

describe('isBaselineEnvironment', () => {
  it('is false when the marker file is absent', () => {
    expect(isBaselineEnvironment(join(tmpdir(), 'karst-no-such-marker'))).toBe(false);
  });

  it('is true when the marker file is there', () => {
    const dir = pathWith('visual-baseline-env');
    expect(isBaselineEnvironment(join(dir, 'visual-baseline-env'))).toBe(true);
  });

  it('names the path the sandbox image writes', () => {
    expect(BASELINE_ENV_MARKER).toBe('/opt/karst/visual-baseline-env');
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

describe('envFromDockerArgs', () => {
  it('collects the -e pairs the container would have carried', () => {
    expect(
      envFromDockerArgs([
        'run',
        '-e',
        'KARST_LAYOUT_AUTHORITATIVE=1',
        '-e',
        'KARST_LAYOUT_SEED=1',
        '-v',
        '{repo}:/work',
      ]),
    ).toEqual({ KARST_LAYOUT_AUTHORITATIVE: '1', KARST_LAYOUT_SEED: '1' });
  });

  it('keeps a value that contains an equals sign whole', () => {
    expect(envFromDockerArgs(['-e', 'A=b=c'])).toEqual({ A: 'b=c' });
  });

  it('ignores a malformed pair', () => {
    expect(envFromDockerArgs(['-e', 'NOPE'])).toEqual({});
    expect(envFromDockerArgs(['-e'])).toEqual({});
  });
});

describe('readLocalCommand', () => {
  it('reads the local command and leaves the rest of the argv alone', () => {
    const out = readLocalCommand(['--local', 'npm test', 'run', '--rm']);
    expect(out).toEqual({ command: 'npm test', rest: ['run', '--rm'] });
  });

  it('is null when the script names no local command', () => {
    expect(readLocalCommand(['run', '--rm'])).toBeNull();
  });
});

describe('gatePlan', () => {
  const local = { command: 'npm test', rest: ['run', '-e', 'A=1'] };

  it('runs the container when docker is there', () => {
    expect(gatePlan({ docker: true, baseline: false, local })).toEqual({ kind: 'docker' });
  });

  it('runs the sweep locally when there is no docker but this IS the baseline environment', () => {
    expect(gatePlan({ docker: false, baseline: true, local })).toEqual({
      kind: 'local',
      command: 'npm test',
      env: { A: '1' },
    });
  });

  it('reports the capability as missing when there is no docker and no baseline environment', () => {
    expect(gatePlan({ docker: false, baseline: false, local })).toEqual({ kind: 'missing' });
  });

  it('reports the capability as missing when the environment is the baseline one but names no local command', () => {
    expect(gatePlan({ docker: false, baseline: true, local: null })).toEqual({ kind: 'missing' });
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
