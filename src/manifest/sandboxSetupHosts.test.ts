import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP_HOSTS, SETUP_HOST_PORT, setupHostError, setupHostsOf } from './sandboxSetupHosts.js';

describe('sandboxSetupHosts', () => {
  it('exposes the 5 default setup hosts on port 443', () => {
    expect(SETUP_HOST_PORT).toBe(443);
    expect(DEFAULT_SETUP_HOSTS).toEqual([
      'registry.npmjs.org',
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'nodejs.org',
    ]);
  });

  it('setupHostsOf returns DEFAULT_SETUP_HOSTS for undefined or empty list', () => {
    expect(setupHostsOf(undefined)).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf([])).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf(undefined)).toContain('release-assets.githubusercontent.com');
    expect(setupHostsOf(undefined)).toContain('nodejs.org');
  });

  it('setupHostsOf replaces defaults completely when declared (no merge)', () => {
    const custom = ['pypi.org', 'files.pythonhosted.org'];
    const result = setupHostsOf(custom);
    expect(result).toBe(custom);
    expect(result).not.toContain('registry.npmjs.org');
    expect(result).not.toContain('release-assets.githubusercontent.com');
  });

  it('every default setup host passes setupHostError validation', () => {
    for (const host of DEFAULT_SETUP_HOSTS) {
      expect(setupHostError(host)).toBeUndefined();
    }
  });

  it('validates host formats and rejects invalid host strings or host alias', () => {
    for (const valid of ['registry.npmjs.org', '*.githubusercontent.com', 'localhost', 'sub.domain.co.uk']) {
      expect(setupHostError(valid)).toBeUndefined();
    }
    const maxValid = 'a.' + 'b'.repeat(251);
    expect(maxValid.length).toBe(253);
    expect(setupHostError(maxValid)).toBeUndefined();

    const tooLong = 'a.' + 'b'.repeat(252);
    expect(tooLong.length).toBe(254);
    expect(setupHostError(tooLong)).toBe(`"${tooLong}" is not a host name or *.suffix`);

    expect(setupHostError('host.docker.internal')).toBe('must not be the host alias (baseline ports only)');

    for (const bad of ['a b', 'x:443', 'https://x.io', '-x.io', '*', 'a,b', '']) {
      expect(setupHostError(bad)).toBe(`"${bad}" is not a host name or *.suffix`);
    }
  });
});
