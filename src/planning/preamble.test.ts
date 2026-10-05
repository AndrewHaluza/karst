import { describe, it, expect } from 'vitest';
import { repo } from '../manifest/fixtures.js';
import { planningPreamble, planningAddDirs } from './preamble.js';

const manifest = {
  baselineBranch: 'main',
  repositories: {
    api: repo({ repoPath: '/src/api', baselineBranch: 'develop' }),
    web: repo({ repoPath: '/src/web' }),
    old: repo({ repoPath: '/src/old', enabled: false }),
  },
};

describe('planningPreamble', () => {
  const text = planningPreamble({ sessionId: 7, title: 'Auth rework', manifest });

  it('lists every enabled repository with its path and base branch', () => {
    expect(text).toContain('- api: /src/api (base develop)');
    expect(text).toContain('- web: /src/web (base main)');
    expect(text).not.toContain('/src/old');
  });

  it('states the session is read-only and names the filing verb with its session id', () => {
    expect(text).toMatch(/read-only/i);
    expect(text).toContain('karst draft create --session 7');
    expect(text).toContain('--summary-file');
  });

  it('carries the session title', () => {
    expect(text).toContain('Auth rework');
  });
});

describe('planningAddDirs', () => {
  it('returns enabled repository paths, deduplicated (monorepos share a repoPath)', () => {
    const shared = {
      ...manifest,
      repositories: { ...manifest.repositories, admin: repo({ repoPath: '/src/web' }) },
    };
    expect(planningAddDirs(shared)).toEqual(['/src/api', '/src/web']);
  });
});
