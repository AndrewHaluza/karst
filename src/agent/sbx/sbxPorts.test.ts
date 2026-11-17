import { describe, expect, it } from 'vitest';
import { isPortTakenError, isResourceAllowed, parseSbxAllowed, parseSbxPorts, sbxPolicyArgs, sbxPolicyListArgs, sbxPublishArgs, sbxUnpublishArgs } from './sbxPorts.js';

describe('sbxPorts', () => {
  it('publishes one declared port to the allocated host port on 127.0.0.1 only', () => {
    expect(sbxPublishArgs('karst-ab-1-claude', { hostPort: 4100, sandboxPort: 4100 })).toEqual([
      'ports', 'karst-ab-1-claude', '--publish', '127.0.0.1:4100:4100',
    ]);
    expect(sbxUnpublishArgs('karst-ab-1-claude', { hostPort: 4100, sandboxPort: 3000 })).toEqual([
      'ports', 'karst-ab-1-claude', '--unpublish', '127.0.0.1:4100:3000',
    ]);
  });

  it('refuses a port outside 1..65535', () => {
    expect(() => sbxPublishArgs('n', { hostPort: 0, sandboxPort: 1 })).toThrow(/port/);
    expect(() => sbxPublishArgs('n', { hostPort: 1, sandboxPort: 65536 })).toThrow(/port/);
    expect(() => sbxPublishArgs('n', { hostPort: 1.5, sandboxPort: 1 })).toThrow(/port/);
  });

  it('parses the listing, keeping only 127.0.0.1 tcp rows', () => {
    const out = [
      'HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL',
      '127.0.0.1   18123       8123           tcp4',
      '0.0.0.0     9000        9000           tcp',
      '127.0.0.1   18124       8124           udp',
      '',
    ].join('\n');
    expect(parseSbxPorts(out)).toEqual([{ hostPort: 18123, sandboxPort: 8123 }]);
    expect(parseSbxPorts('No published ports\n')).toEqual([]);
  });

  it('recognizes a busy host port', () => {
    expect(isPortTakenError('Error: listen tcp 127.0.0.1:4100: bind: address already in use')).toBe(true);
    expect(isPortTakenError('port is already allocated')).toBe(true);
    expect(isPortTakenError('sandbox not running')).toBe(false);
  });

  it('allows exactly the declared baseline host ports, on both host forms, scoped to one sandbox', () => {
    expect(sbxPolicyArgs('allow', 'n', [5432, 6379])).toEqual([
      'policy', 'allow', 'network', '--sandbox', 'n', 'localhost:5432,host.docker.internal:5432,localhost:6379,host.docker.internal:6379',
    ]);
    expect(sbxPolicyArgs('rm', 'n', [5432])).toEqual([
      'policy', 'rm', 'network', '--sandbox', 'n', '--resource', 'localhost:5432,host.docker.internal:5432', '--force',
    ]);
    expect(() => sbxPolicyArgs('allow', 'n', [])).toThrow(/no ports/);
  });
});

describe('sbx policy listing', () => {
  const json = JSON.stringify({ rules: [
    { decision: 'allow', resource_type: 'network', resources: ['**.githubusercontent.com:443', 'Github.com:443'] },
    { decision: 'deny', resource_type: 'network', resources: ['evil.example:443'] },
    { decision: 'allow', resource_type: 'filesystem', resources: ['/tmp:1'] },
  ] });

  it('lists with the v0.48.0 form: the sandbox is positional, not --sandbox', () => {
    expect(sbxPolicyListArgs('n1')).toEqual(['policy', 'ls', 'n1', '--json']);
  });

  it('reads only allowed network resources from the JSON listing', () => {
    expect([...parseSbxAllowed(json)].sort()).toEqual(['**.githubusercontent.com:443', 'github.com:443']);
  });

  it('falls back to the resource shape for a table listing', () => {
    expect(parseSbxAllowed('allow network Registry.npmjs.org:443')).toEqual(new Set(['registry.npmjs.org:443']));
  });

  it('a single-star wildcard covers one label, a double-star any depth', () => {
    const allowed = new Set(['*.example.com:443', '**.deep.org:443']);
    expect(isResourceAllowed(allowed, 'a.example.com:443')).toBe(true);
    expect(isResourceAllowed(allowed, 'a.b.example.com:443')).toBe(false);
    expect(isResourceAllowed(allowed, 'a.b.deep.org:443')).toBe(true);
  });

  it('a wildcard covers a subdomain on the same port only', () => {
    const allowed = parseSbxAllowed(json);
    expect(isResourceAllowed(allowed, 'objects.githubusercontent.com:443')).toBe(true);
    expect(isResourceAllowed(allowed, 'a.b.githubusercontent.com:443')).toBe(true);
    expect(isResourceAllowed(allowed, 'objects.githubusercontent.com:80')).toBe(false);
    expect(isResourceAllowed(allowed, 'githubusercontent.com:443')).toBe(false);
    expect(isResourceAllowed(allowed, 'notgithubusercontent.com:443')).toBe(false);
    expect(isResourceAllowed(allowed, 'evil.example:443')).toBe(false);
    expect(isResourceAllowed(allowed, 'GitHub.com:443')).toBe(true);
  });
});
