import { describe, expect, it } from 'vitest';
import { isPortTakenError, parseSbxPorts, sbxPolicyArgs, sbxPublishArgs, sbxUnpublishArgs } from './sbxPorts.js';

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

  it('allows exactly the declared baseline host ports, scoped to one sandbox', () => {
    expect(sbxPolicyArgs('allow', 'n', [5432, 6379])).toEqual([
      'policy', 'allow', 'network', '--sandbox', 'n', 'host.docker.internal:5432,host.docker.internal:6379',
    ]);
    expect(sbxPolicyArgs('rm', 'n', [5432])).toEqual([
      'policy', 'rm', 'network', '--sandbox', 'n', 'host.docker.internal:5432',
    ]);
    expect(() => sbxPolicyArgs('allow', 'n', [])).toThrow(/no ports/);
  });
});
