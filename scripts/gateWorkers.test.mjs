import { describe, expect, it } from 'vitest';
import { DOCKER_INFO_TIMEOUT_MS, dockerCpus, gateWorkers, parseDockerCpus, workersLine } from './gateWorkers.mjs';

describe('gateWorkers', () => {
  it('passes an explicit KARST_VISUAL_WORKERS through unchanged, for any CPU count', () => {
    for (const cpus of [1, 6, 16, null]) {
      expect(gateWorkers({ env: { KARST_VISUAL_WORKERS: '2' }, cpus })).toEqual({ workers: '2', source: 'env' });
    }
  });

  it('counts an empty KARST_VISUAL_WORKERS as set (an explicit opt-out)', () => {
    expect(gateWorkers({ env: { KARST_VISUAL_WORKERS: '' }, cpus: 6 })).toEqual({ workers: '', source: 'env' });
  });

  it('keeps 2 CPUs free and caps the count at 4', () => {
    const cases = [
      [16, '4'],
      [6, '4'],
      [5, '3'],
      [4, '2'],
      [3, '1'],
      [2, '1'],
      [1, '1'],
    ];
    for (const [cpus, workers] of cases) {
      expect(gateWorkers({ env: {}, cpus })).toEqual({ workers, source: 'docker' });
    }
  });

  it('falls back to 1 worker when the CPU count is unknown', () => {
    for (const cpus of [null, 0, Number.NaN, -1]) {
      expect(gateWorkers({ env: {}, cpus })).toEqual({ workers: '1', source: 'fallback' });
    }
  });

  it('does not change the env it receives', () => {
    const env = Object.freeze({});
    expect(() => gateWorkers({ env, cpus: 6 })).not.toThrow();
  });
});

describe('parseDockerCpus', () => {
  it('reads the CPU count of `docker info`', () => {
    expect(parseDockerCpus('6\n')).toBe(6);
  });

  it('gives null for an empty, a non-numeric or a zero count', () => {
    for (const stdout of ['', 'abc', '0', '6 cpus', '-2']) expect(parseDockerCpus(stdout)).toBeNull();
  });
});

describe('workersLine', () => {
  it('names the count and where it came from', () => {
    expect(workersLine({ workers: '4', source: 'docker', cpus: 6 })).toBe(
      'visual: 4 workers (docker 6 CPUs; KARST_VISUAL_WORKERS overrides)',
    );
    expect(workersLine({ workers: '2', source: 'env', cpus: 6 })).toBe('visual: 2 workers (KARST_VISUAL_WORKERS)');
    expect(workersLine({ workers: '1', source: 'fallback', cpus: null })).toBe(
      'visual: 1 worker (docker CPU count unknown)',
    );
  });
});

describe('dockerCpus', () => {
  const fakeExec = (outcome) => {
    const calls = [];
    const exec = (file, args, options, callback) => {
      calls.push({ file, args, options });
      queueMicrotask(() => callback(outcome.error ?? null, outcome.stdout ?? ''));
    };
    return { exec, calls };
  };

  it('asks docker info for the CPU count, with a time limit', async () => {
    const { exec, calls } = fakeExec({ stdout: '6\n' });
    expect(await dockerCpus(exec)).toBe(6);
    expect(calls).toEqual([
      { file: 'docker', args: ['info', '--format', '{{.NCPU}}'], options: { encoding: 'utf8', timeout: DOCKER_INFO_TIMEOUT_MS } },
    ]);
    expect(DOCKER_INFO_TIMEOUT_MS).toBe(10_000);
  });

  it('gives null when docker info fails or times out', async () => {
    const { exec } = fakeExec({ error: new Error('timeout'), stdout: '6\n' });
    expect(await dockerCpus(exec)).toBeNull();
  });

  it('gives null when docker info cannot start', async () => {
    const exec = () => {
      throw new Error('spawn docker ENOENT');
    };
    expect(await dockerCpus(exec)).toBeNull();
  });
});
