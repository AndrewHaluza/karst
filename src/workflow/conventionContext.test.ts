import { describe, expect, it } from 'vitest';
import {
  resolveRepoConventions,
  resolveRepoName,
  resolveRepoScope,
  resolveTicketType,
} from './conventionContext.js';
import { manifest, repo } from '../manifest/fixtures.js';

describe('resolveTicketType', () => {
  it('prefers the ticket, then the project default, then feat', () => {
    expect(resolveTicketType({ type: 'fix' }, { defaultType: 'chore' })).toBe('fix');
    expect(resolveTicketType({ type: null }, { defaultType: 'chore' })).toBe('chore');
    expect(resolveTicketType({ type: null }, {})).toBe('feat');
    expect(resolveTicketType({ type: null })).toBe('feat');
  });
});

describe('resolveRepoScope', () => {
  const m = manifest({
    frontend: repo({ repoPath: '/repos/frontend', scope: 'web' }),
    backend: repo({ repoPath: '/repos/backend' }),
  });

  it('uses the repository scope when set, else the repository name', () => {
    expect(resolveRepoScope(m, 'frontend')).toBe('web');
    expect(resolveRepoScope(m, 'backend')).toBe('backend');
  });

  it('falls back to the repository name with no manifest or unknown repo', () => {
    expect(resolveRepoScope(undefined, 'frontend')).toBe('frontend');
    expect(resolveRepoScope(m, 'gone')).toBe('gone');
  });
});

describe('resolveRepoConventions', () => {
  it('is undefined when neither the repo nor the global block configures anything', () => {
    const m = manifest({ frontend: repo({ repoPath: '/repos/frontend' }) });
    expect(resolveRepoConventions(m, 'frontend')).toBeUndefined();
    expect(resolveRepoConventions(undefined, 'frontend')).toBeUndefined();
  });

  it('uses the repo override per key, falling back to the global per key', () => {
    const m = manifest(
      {
        web: repo({
          repoPath: '/repos/web',
          conventions: {
            commitMessage: 'repo-commit',
            pullRequestTitle: 'repo-title',
          },
        }),
        other: repo({ repoPath: '/repos/other' }),
      },
      {
        conventions: {
          commitMessage: 'global-commit',
          pullRequestTitle: 'global-title',
          pullRequestDescription: 'global-body',
          defaultType: 'chore',
        },
      },
    );

    // Every key falls back INDEPENDENTLY: the repo sets commit + title but not
    // the body, and the project-wide defaultType rides along untouched.
    expect(resolveRepoConventions(m, 'web')).toEqual({
      commitMessage: 'repo-commit',
      pullRequestTitle: 'repo-title',
      pullRequestDescription: 'global-body',
      defaultType: 'chore',
    });
    // A repo with no override of its own inherits the whole global block.
    expect(resolveRepoConventions(m, 'other')).toEqual({
      commitMessage: 'global-commit',
      pullRequestTitle: 'global-title',
      pullRequestDescription: 'global-body',
      defaultType: 'chore',
    });
  });

  it('carries only the repo override when there is no global block', () => {
    const m = manifest({
      contract: repo({
        repoPath: '/repos/contract',
        conventions: { pullRequestTitle: 'feat: {title} [{key}]' },
      }),
    });
    expect(resolveRepoConventions(m, 'contract')).toEqual({
      pullRequestTitle: 'feat: {title} [{key}]',
    });
  });
});

describe('resolveRepoName', () => {
  const m = manifest({
    frontend: repo({ repoPath: '/repos/frontend', scope: 'web' }),
    backend: repo({ repoPath: '/repos/backend' }),
  });

  it('resolves the manifest entry name for a worktree repo path', () => {
    expect(resolveRepoName(m, '/repos/frontend')).toBe('frontend');
    expect(resolveRepoName(m, '/repos/backend')).toBe('backend');
  });

  it('returns the path when the manifest is absent or the path is unmapped', () => {
    expect(resolveRepoName(undefined, '/repos/frontend')).toBe('/repos/frontend');
    expect(resolveRepoName(m, '/elsewhere')).toBe('/elsewhere');
  });

  it('answers the first declared entry when several share a repoPath', () => {
    const shared = manifest({
      fe: repo({ repoPath: '/repos/mono' }),
      admin: repo({ repoPath: '/repos/mono' }),
    });
    expect(resolveRepoName(shared, '/repos/mono')).toBe('fe');
  });
});
