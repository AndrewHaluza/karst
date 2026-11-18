import { describe, expect, it } from 'vitest';
import { APPROVAL_KEY_ENV, approvalExecArgs, KEY_ENV, oauthBaseUrl, oauthLaunchArgs, oauthPolicyArgs } from './sbxOauthGuest.js';

const KEY = 'k'.repeat(23) + 'ABCDEFGHIJKLMNOPQRST';

describe('oauthBaseUrl', () => {
  it('points the guest at the host alias, never localhost', () => {
    expect(oauthBaseUrl(8787)).toBe('http://host.docker.internal:8787');
  });
});

describe('oauthLaunchArgs', () => {
  it('passes the base url as a pair and the key as a bare name, so the key is never in argv', () => {
    const args = oauthLaunchArgs(8787);
    expect(args).toEqual(['--env', 'ANTHROPIC_BASE_URL=http://host.docker.internal:8787', '--env', KEY_ENV]);
    expect(args.join(' ')).not.toContain('=' + KEY);
  });
});

describe('oauthPolicyArgs', () => {
  it('allows the proxy port in both host forms, which sbx matches as localhost for HTTP', () => {
    expect(oauthPolicyArgs('allow', 'sb', 8787)).toEqual(['policy', 'allow', 'network', '--sandbox', 'sb', 'localhost:8787,host.docker.internal:8787']);
    expect(oauthPolicyArgs('rm', 'sb', 8787).slice(0, 5)).toEqual(['policy', 'rm', 'network', '--sandbox', 'sb']);
  });
});

describe('approvalExecArgs', () => {
  it('names the key by environment variable, never by value', () => {
    const args = approvalExecArgs('sb');
    expect(args.slice(0, 4)).toEqual(['exec', '--env', APPROVAL_KEY_ENV, 'sb']);
    expect(args.join(' ')).not.toContain(KEY);
  });

});
