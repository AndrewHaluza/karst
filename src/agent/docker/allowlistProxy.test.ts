import { describe, expect, it } from 'vitest';
import { isAllowedHost, parseAllowlist, parseConnectTarget } from './allowlistProxy.js';

describe('parseAllowlist', () => {
  it('splits, trims, lowercases and drops blanks and trailing dots', () => {
    expect(parseAllowlist(' OpenCode.ai, ,models.dev.,')).toEqual(['opencode.ai', 'models.dev']);
  });
  it('is empty for an absent or blank value (deny all)', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
  });
});

describe('isAllowedHost', () => {
  const allow = ['opencode.ai', 'registry.npmjs.org'];
  it('allows the exact host and its subdomains, case-insensitively', () => {
    expect(isAllowedHost('opencode.ai', allow)).toBe(true);
    expect(isAllowedHost('models.OpenCode.ai.', allow)).toBe(true);
  });
  it('denies lookalikes, parents and empty hosts', () => {
    expect(isAllowedHost('evilopencode.ai', allow)).toBe(false);
    expect(isAllowedHost('npmjs.org', allow)).toBe(false);
    expect(isAllowedHost('', allow)).toBe(false);
    expect(isAllowedHost('opencode.ai', [])).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('parses host:port and bracketed IPv6', () => {
    expect(parseConnectTarget('opencode.ai:443')).toEqual({ host: 'opencode.ai', port: 443 });
    expect(parseConnectTarget('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
  });
  it('rejects malformed or out-of-range targets', () => {
    for (const bad of [undefined, '', 'opencode.ai', 'a:b', 'a:0', 'a:65536', 'a:443:1', '/x', 'a:123456']) {
      expect(parseConnectTarget(bad)).toBeNull();
    }
  });
  it('accepts the port bounds', () => {
    expect(parseConnectTarget('a:1')).toEqual({ host: 'a', port: 1 });
    expect(parseConnectTarget('a:65535')).toEqual({ host: 'a', port: 65535 });
  });
});

describe('parseHostPorts', () => {
  it('reads exact host:port pairs and drops malformed entries', async () => {
    const { parseHostPorts } = await import('./allowlistProxy.js');
    expect(parseHostPorts('host.docker.internal:5432, HOST.docker.internal:6379 ,bad,x:0,')).toEqual([
      { host: 'host.docker.internal', port: 5432 },
      { host: 'host.docker.internal', port: 6379 },
    ]);
    expect(parseHostPorts(undefined)).toEqual([]);
  });
});
