import { describe, it, expect } from 'vitest';
import {
  isRunnable,
  nonRunnableNames,
  repoOfKey,
  resolveTarget,
  serviceUnits,
  unitByKey,
  unitsOfRepos,
  runnableSubset,
  serviceOf,
} from './runnable.js';
import { manifest, repo, svc } from './fixtures.js';

/** api runs; docs does not. The asymmetry is the whole point of the module. */
function mixed() {
  return manifest({
    api: repo({ service: svc({ start: 'node server.mjs' }) }),
    docs: repo({ repoPath: '/repo/docs' }),
  });
}

describe('isRunnable', () => {
  it('is true for a repository declaring a service', () => {
    expect(isRunnable(repo({ service: svc() }))).toBe(true);
  });

  it('is false for a repository with no service', () => {
    expect(isRunnable(repo())).toBe(false);
  });
});

describe('serviceUnits', () => {
  it('yields one unit per runnable repository, keyed by the repository name', () => {
    expect(serviceUnits(mixed()).map((u) => u.key)).toEqual(['api']);
  });

  it('keys a services map entry as repo/service, sharing one repository', () => {
    const m = manifest({
      mono: repo({ services: { web: svc({ cwd: 'apps/web' }), api: svc() } }),
      docs: repo(),
    });
    const units = serviceUnits(m);
    expect(units.map((u) => u.key)).toEqual(['mono/web', 'mono/api']);
    expect(units.every((u) => u.repo === 'mono')).toBe(true);
    expect(units[0]!.def.cwd).toBe('apps/web');
  });

  it('returns [] when nothing is runnable', () => {
    expect(serviceUnits(manifest({ docs: repo() }))).toEqual([]);
  });
});

describe('unitByKey / repoOfKey', () => {
  const m = manifest({
    mono: repo({ services: { web: svc(), api: svc() } }),
    solo: repo({ service: svc() }),
  });
  it('finds a unit by key', () => {
    expect(unitByKey(m, 'mono/api')?.name).toBe('api');
    expect(unitByKey(m, 'solo')?.repo).toBe('solo');
    expect(unitByKey(m, 'mono')).toBeUndefined();
  });
  it('maps a key to its repository, even for an unknown key', () => {
    expect(repoOfKey(m, 'mono/web')).toBe('mono');
    expect(repoOfKey(m, 'gone/x')).toBe('gone');
  });
});

describe('resolveTarget', () => {
  const repos = manifest({
    mono: repo({ services: { web: svc(), api: svc() } }),
    one: repo({ services: { only: svc() } }),
    solo: repo({ service: svc() }),
    docs: repo(),
  }).repositories;

  it('accepts a bare repo only when it has exactly one service', () => {
    expect(resolveTarget(repos, 'solo')).toMatchObject({ unit: { key: 'solo' } });
    expect(resolveTarget(repos, 'one')).toMatchObject({ unit: { key: 'one/only' } });
    expect(resolveTarget(repos, 'mono')).toEqual({
      error: expect.stringContaining('has 2 services (web, api)'),
    });
  });
  it('accepts repo/service', () => {
    expect(resolveTarget(repos, 'mono/api')).toMatchObject({ unit: { key: 'mono/api' } });
    expect(resolveTarget(repos, 'solo/solo')).toMatchObject({ unit: { key: 'solo' } });
  });
  it('explains each failure', () => {
    expect(resolveTarget(repos, 'nope')).toEqual({ error: 'targets unknown repository "nope"' });
    expect(resolveTarget(repos, 'mono/db')).toEqual({
      error: 'targets unknown service "db" on "mono" (has: web, api)',
    });
    expect(resolveTarget(repos, 'docs')).toEqual({
      error: expect.stringContaining('declares no service'),
    });
  });
});

describe('nonRunnableNames', () => {
  it('lists repositories with no service', () => {
    expect(nonRunnableNames(mixed())).toEqual(['docs']);
  });

  it('returns [] when everything runs', () => {
    expect(nonRunnableNames(manifest({ api: repo({ service: svc() }) }))).toEqual([]);
  });
});

describe('serviceOf', () => {
  it('returns the service of a runnable repository', () => {
    expect(serviceOf(mixed(), 'api')?.start).toBe('node server.mjs');
  });

  it('returns undefined for a known but non-runnable repository', () => {
    expect(serviceOf(mixed(), 'docs')).toBeUndefined();
  });

  it('returns undefined for an unknown repository', () => {
    expect(serviceOf(mixed(), 'nope')).toBeUndefined();
  });
});

describe('runnableSubset', () => {
  it('drops non-runnable and unknown names, preserving order', () => {
    expect(runnableSubset(mixed(), ['docs', 'api', 'ghost'])).toEqual(['api']);
  });

  it('does not mutate the input array', () => {
    const hot = ['docs', 'api'];
    runnableSubset(mixed(), hot);
    expect(hot).toEqual(['docs', 'api']);
  });
});

describe('isRunnable with a services map', () => {
  it('is true for a non-empty map, false for an empty one', () => {
    expect(isRunnable(repo({ services: { web: svc() } }))).toBe(true);
    expect(isRunnable(repo({ services: {} }))).toBe(false);
  });
});

describe('serviceOf / unitsOfRepos with a services map', () => {
  const m = manifest({
    mono: repo({ services: { web: svc(), api: svc() } }),
    one: repo({ services: { only: svc({ start: 'x' }) } }),
  });
  it('serviceOf is the lone service, undefined for several', () => {
    expect(serviceOf(m, 'one')?.start).toBe('x');
    expect(serviceOf(m, 'mono')).toBeUndefined();
  });
  it('expands repositories to their units, skipping unknown names', () => {
    expect(unitsOfRepos(m, ['mono', 'ghost']).map((u) => u.key)).toEqual(['mono/web', 'mono/api']);
  });
});
