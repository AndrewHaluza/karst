import { describe, it, expect, vi } from 'vitest';
import { resolveGithubToken, type GithubAuthDeps } from './githubAuth.js';

function deps(over: Partial<GithubAuthDeps> = {}): GithubAuthDeps {
  return {
    vscodeSession: async () => undefined,
    ghCli: async () => undefined,
    env: {},
    ...over,
  };
}

describe('resolveGithubToken', () => {
  it('prefers the VS Code session over everything', async () => {
    const ghCli = vi.fn(async () => 'gh');
    const t = await resolveGithubToken(
      deps({ vscodeSession: async () => 'vs', ghCli, env: { GH_TOKEN: 'e' } }),
    );
    expect(t).toBe('vs');
    expect(ghCli).not.toHaveBeenCalled();
  });

  it('falls through gh, GH_TOKEN, GITHUB_TOKEN in order', async () => {
    expect(await resolveGithubToken(deps({ ghCli: async () => ' gh \n', env: { GH_TOKEN: 'e' } }))).toBe('gh');
    expect(await resolveGithubToken(deps({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b' } }))).toBe('a');
    expect(await resolveGithubToken(deps({ env: { GITHUB_TOKEN: 'b' } }))).toBe('b');
  });

  it('returns undefined with no source, and treats a throwing source as a miss', async () => {
    expect(await resolveGithubToken(deps())).toBeUndefined();
    const t = await resolveGithubToken(
      deps({
        vscodeSession: async () => {
          throw new Error('boom');
        },
        env: { GITHUB_TOKEN: 'b' },
      }),
    );
    expect(t).toBe('b');
  });
});
