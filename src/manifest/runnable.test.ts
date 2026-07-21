import { describe, it, expect } from 'vitest';
import {
  isRunnable,
  nonRunnableNames,
  runnableEntries,
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

describe('runnableEntries', () => {
  it('yields only repositories that declare a service', () => {
    expect(runnableEntries(mixed()).map(([name]) => name)).toEqual(['api']);
  });

  it('narrows service so no non-null assertion is needed', () => {
    const entry = runnableEntries(mixed())[0]!;
    // If `service` were still optional, `.service.start` would not typecheck.
    expect(entry[1].service.start).toBe('node server.mjs');
  });

  it('returns [] when nothing is runnable', () => {
    expect(runnableEntries(manifest({ docs: repo() }))).toEqual([]);
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
