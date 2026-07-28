import { describe, expect, it } from 'vitest';
import { resolveRepoScope, resolveTicketType } from './conventionContext.js';
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
