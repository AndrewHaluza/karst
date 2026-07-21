import { describe, it, expect } from 'vitest';
import { validateManifest } from '../schema.js';
import { isRepoClassified, unclassifiedRepos } from './graph.js';
import { manifest, repo, runnableRepo } from '../fixtures.js';

/**
 * Cross-repository validation. Each case here is a config that the OLD schema
 * accepted and that failed later — at spin, at spawn, or not at all (silently
 * wiring the stack to the wrong port).
 */

/** Build a raw YAML-shaped tree, since validateManifest takes untyped input. */
function raw(repositories: Record<string, unknown>): Record<string, unknown> {
  return {
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'develop',
    repositories,
  };
}

const service = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  start: 'npm run dev',
  ports: [{ name: 'http', env: 'PORT', default: 3000 }],
  dependsOn: [],
  ...over,
});

describe('repoPath', () => {
  // Two repository entries at one directory are a monorepo with several
  // runnable processes — the worktree slug is per-TICKET (not per-service), so
  // they intentionally map to one worktree and branch. spin/preflight/scope
  // dedup their worktree-creation loops by repoPath for exactly this reason
  // (see 53314d6, "fix: rename-invariant worktree slug from ticket key+title").
  // This must stay accepted; do not reintroduce a reject-on-shared-repoPath check.
  it('allows two repositories to share a repoPath (a monorepo with two runnable processes)', () => {
    expect(() =>
      validateManifest(
        raw({
          api: { repoPath: '/repo/shared', service: service() },
          web: { repoPath: '/repo/shared', service: service() },
        }),
      ),
    ).not.toThrow();
  });

  it('allows two non-runnable repositories to share a repoPath', () => {
    expect(() =>
      validateManifest(
        raw({
          api: { repoPath: '/repo/shared' },
          web: { repoPath: '/repo/shared' },
        }),
      ),
    ).not.toThrow();
  });

  it('allows distinct repoPaths', () => {
    expect(() =>
      validateManifest(raw({ api: { repoPath: '/a' }, web: { repoPath: '/b' } })),
    ).not.toThrow();
  });
});

describe('dependsOn edges', () => {
  it('rejects an edge to an unknown repository', () => {
    expect(() =>
      validateManifest(
        raw({
          web: {
            repoPath: '/web',
            service: service({
              dependsOn: [{ target: 'ghost', port: 'http', bind: [{ env: 'A', template: '{port}' }] }],
            }),
          },
        }),
      ),
    ).toThrow(/targets unknown repository "ghost"/);
  });

  // The new model's own contradiction: you cannot bind to a port that does not
  // exist. Without this, `effectivePort` would throw at resolve time instead.
  it('rejects an edge to a repository that declares no service', () => {
    expect(() =>
      validateManifest(
        raw({
          docs: { repoPath: '/docs' },
          web: {
            repoPath: '/web',
            service: service({
              dependsOn: [{ target: 'docs', port: 'http', bind: [{ env: 'A', template: '{port}' }] }],
            }),
          },
        }),
      ),
    ).toThrow(/declares no service/);
  });

  it('tells the author how to fix a non-runnable target', () => {
    try {
      validateManifest(
        raw({
          docs: { repoPath: '/docs' },
          web: {
            repoPath: '/web',
            service: service({
              dependsOn: [{ target: 'docs', port: 'http', bind: [{ env: 'A', template: '{port}' }] }],
            }),
          },
        }),
      );
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/or drop the dependency/);
    }
  });

  it('rejects an edge naming a port slot the target does not own, listing what it has', () => {
    expect(() =>
      validateManifest(
        raw({
          api: { repoPath: '/api', service: service() },
          web: {
            repoPath: '/web',
            service: service({
              dependsOn: [{ target: 'api', port: 'ws', bind: [{ env: 'A', template: '{port}' }] }],
            }),
          },
        }),
      ),
    ).toThrow(/has no such port slot \(has: http\)/);
  });

  // A self-edge is a cycle topoSort only sometimes catches, depending on whether
  // the repository is in the hot set.
  it('rejects a service depending on itself', () => {
    expect(() =>
      validateManifest(
        raw({
          api: {
            repoPath: '/api',
            service: service({
              dependsOn: [{ target: 'api', port: 'http', bind: [{ env: 'A', template: '{port}' }] }],
            }),
          },
        }),
      ),
    ).toThrow(/cannot depend on itself/);
  });

  // Two binds writing one env var: which wins depends on iteration order.
  it('rejects duplicate bind env vars within one edge', () => {
    expect(() =>
      validateManifest(
        raw({
          api: { repoPath: '/api', service: service() },
          web: {
            repoPath: '/web',
            service: service({
              dependsOn: [
                {
                  target: 'api',
                  port: 'http',
                  bind: [
                    { env: 'API_URL', template: 'http://{host}:{port}' },
                    { env: 'API_URL', template: '{port}' },
                  ],
                },
              ],
            }),
          },
        }),
      ),
    ).toThrow(/bind\[1\] env "API_URL" duplicates/);
  });
});

describe('port slot sanity', () => {
  // Slot names are referenced by dependsOn.port; a duplicate silently shadows.
  it('rejects duplicate slot names within one service', () => {
    expect(() =>
      validateManifest(
        raw({
          api: {
            repoPath: '/api',
            service: service({
              ports: [
                { name: 'http', env: 'PORT', default: 3000 },
                { name: 'http', env: 'ALT_PORT', default: 3001 },
              ],
            }),
          },
        }),
      ),
    ).toThrow(/ports\[1\] name "http" duplicates/);
  });

  // Env vars are injected at spawn; a duplicate means one port never lands.
  it('rejects duplicate env vars within one service', () => {
    expect(() =>
      validateManifest(
        raw({
          api: {
            repoPath: '/api',
            service: service({
              ports: [
                { name: 'http', env: 'PORT', default: 3000 },
                { name: 'debug', env: 'PORT', default: 9229 },
              ],
            }),
          },
        }),
      ),
    ).toThrow(/ports\[1\] env "PORT" duplicates/);
  });

  it.each([0, -1, 70000, 3000.5])('rejects the out-of-range port default %s', (bad) => {
    expect(() =>
      validateManifest(
        raw({
          api: {
            repoPath: '/api',
            service: service({ ports: [{ name: 'http', env: 'PORT', default: bad }] }),
          },
        }),
      ),
    ).toThrow(/integer between 1 and 65535/);
  });

  it('allows the same slot name across DIFFERENT repositories', () => {
    expect(() =>
      validateManifest(
        raw({
          api: { repoPath: '/api', service: service() },
          web: { repoPath: '/web', service: service() },
        }),
      ),
    ).not.toThrow();
  });
});

describe('classification', () => {
  it('treats a repository with signals as classified, runnable or not', () => {
    expect(isRepoClassified(repo({ signals: ['docs'] }))).toBe(true);
    expect(isRepoClassified(runnableRepo({}, { signals: ['api'] }))).toBe(true);
  });

  it('treats absent and empty signals alike as unclassified', () => {
    expect(isRepoClassified(repo())).toBe(false);
    expect(isRepoClassified(repo({ signals: [] }))).toBe(false);
  });

  it('gates non-runnable repositories too — they still need routing', () => {
    const m = manifest({
      docs: repo(),
      api: runnableRepo({}, { repoPath: '/api', signals: ['api'] }),
    });
    expect(unclassifiedRepos(m)).toEqual(['docs']);
  });
});
