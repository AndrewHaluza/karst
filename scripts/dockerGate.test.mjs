import { describe, it, expect } from 'vitest';
import {
  BASELINE_ENV_MARKER,
  dockerArgv,
  gateContainerName,
  withContainerName,
  envFromDockerArgs,
  EXIT_COMMAND_NOT_FOUND,
  gatePlan,
  hasDocker,
  isBaselineEnvironment,
  narrowSweep,
  missingDockerMessage,
  readLocalCommand,
} from './dockerGate.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('the gate scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const steps = (command) => command.split('&&').map((step) => step.trim()).filter(Boolean);
  const localOf = (script) => /--local "([^"]+)"/.exec(pkg.scripts[script])?.[1] ?? null;

  it('runs the same sweep locally as the container runs', () => {
    // The local run is what stands in for the container when the sandbox has
    // no docker, so it must cover the same steps. The install (`npm ci`, now run
    // only when node_modules is empty) is the one it may skip: the tree is already installed.
    expect(steps(localOf('test:visual:docker'))).toEqual(
      steps(pkg.scripts['test:visual:ci']).filter((step) => !step.includes('npm ci')),
    );
  });

  it('runs the same layout sweep locally as the container runs', () => {
    expect(steps(localOf('test:layout:docker'))).toEqual(
      steps(pkg.scripts['test:layout:ci']).filter((step) => !step.includes('npm ci')),
    );
  });

  it('keeps the container command in the gate script', () => {
    // The container path is unchanged: the pinned image, the repo mounted at
    // /work, and the CI script inside it.
    expect(pkg.scripts['test:visual:docker']).toContain('mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(pkg.scripts['test:visual:docker']).toContain('npm run test:visual:ci');
  });
});

describe('gateContainerName', () => {
  it('builds karst-pw-<gate>-<who>-<pid> from the lifecycle event and ticket', () => {
    expect(gateContainerName({ event: 'test:visual:docker', ticket: 'T807', cwd: '/w/x', pid: 42 })).toBe(
      'karst-pw-visual-docker-t807-42',
    );
  });

  it('keeps the :update suffix and maps every colon to a dash', () => {
    expect(gateContainerName({ event: 'test:visual:docker:update', ticket: 'T1', cwd: '/w', pid: 1 })).toBe(
      'karst-pw-visual-docker-update-t1-1',
    );
  });

  it('falls back to the worktree directory name without a ticket', () => {
    expect(gateContainerName({ event: 'test:layout:docker', cwd: '/w/My Tree', pid: 7 })).toBe(
      'karst-pw-layout-docker-my-tree-7',
    );
  });

  it('slugs to the docker name set and collapses repeats', () => {
    const name = gateContainerName({ event: 'test:a', ticket: 'Fix//Bad  Name!!', cwd: '/w', pid: 3 });
    expect(name).toBe('karst-pw-a-fix-bad-name-3');
  });

  it('truncates who so the whole name stays within 63 chars', () => {
    const name = gateContainerName({ event: 'test:visual:docker', ticket: 'x'.repeat(200), cwd: '/w', pid: 123456 });
    expect(name.length).toBe(63);
    expect(name.endsWith('-123456')).toBe(true);
  });

  it('never ends who with a dash after truncation', () => {
    const name = gateContainerName({ event: 'e', ticket: `${'a'.repeat(44)}-bbbb`, cwd: '/w', pid: 9 });
    expect(name).not.toMatch(/--/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('never matches the ticket-service orphan pattern /^karst-t\\d+-/', () => {
    const name = gateContainerName({ event: 't1', ticket: 'T807', cwd: '/w', pid: 1 });
    expect(name).not.toMatch(/^karst-t\d/);
    expect(name.startsWith('karst-pw-')).toBe(true);
  });

  it('uses a placeholder gate and who when nothing is known', () => {
    expect(gateContainerName({ cwd: '/', pid: 5 })).toBe('karst-pw-gate-gate-5');
  });
});

describe('withContainerName', () => {
  it('injects --name right after run', () => {
    expect(withContainerName(['run', '--rm', 'img'], 'n')).toEqual(['run', '--name', 'n', '--rm', 'img']);
  });

  it('leaves a caller-supplied --name alone', () => {
    const argv = ['run', '--name', 'mine', 'img'];
    expect(withContainerName(argv, 'n')).toEqual(argv);
  });

  it('leaves a --name=value form alone', () => {
    const argv = ['run', '--name=mine', 'img'];
    expect(withContainerName(argv, 'n')).toEqual(argv);
  });

  it('leaves non-run commands alone', () => {
    expect(withContainerName(['ps'], 'n')).toEqual(['ps']);
  });
});

describe('gatePlan local path', () => {
  it('is unaffected by container naming', () => {
    const plan = gatePlan({ docker: false, baseline: true, local: { command: 'x', rest: ['-e', 'A=1'] } });
    expect(plan).toEqual({ kind: 'local', command: 'x', env: { A: '1' } });
  });
});

describe('narrowSweep', () => {
  it.each(['KARST_LAYOUT_SEED', 'KARST_LAYOUT_PRUNE'])('leaves the sweep full when %s is set', (intent) => {
    const saved = { ...process.env };
    delete process.env.KARST_UI_GREP;
    process.env[intent] = '1';
    try {
      narrowSweep('test:layout:docker');
      expect(process.env.KARST_UI_GREP).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe('baseRunArgv', () => {
  it('mounts the base worktree and re-runs only the failing screenshots in the same image', async () => {
    const { baseRunArgv } = await import('./dockerGate.mjs');
    const raw = ['run', '--rm', '-v', '{repo}:/work', '-v', 'nm:/work/node_modules', '-w', '/work', 'mcr.microsoft.com/playwright:v1.63.0-noble', 'npm', 'run', 'test:visual:ci'];
    const argv = baseRunArgv(raw, '/tmp/base', [{ project: 'dark', title: "it's", baseline: 'b' }], 'karst-pw-x-1-base');
    expect(argv.slice(0, 3)).toEqual(['run', '--name', 'karst-pw-x-1-base']);
    expect(argv).toContain('/tmp/base:/work');
    expect(argv).not.toContain('npm');
    expect(argv.at(-1)).toContain("'--project=dark' '--grep' 'it'\\''s'");
  });
});
