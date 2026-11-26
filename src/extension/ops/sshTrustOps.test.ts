import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readRemoteTrust, remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import type { RemoteDef } from '../../manifest/types.js';
import { confirmRemoteTrust, sshRemoteFor } from './sshTrustOps.js';

const def: RemoteDef = { host: 'devbox.example.com', user: 'karst', port: 2222, keyPath: '~/.ssh/id_ed25519', mode: 'direct', remoteDir: '/srv/karst' };
const remotes = { devbox: def };

describe('sshRemoteFor', () => {
  it('resolves ssh:<name> to its declared remote, and host or a missing remote to none', () => {
    expect(sshRemoteFor({ claude: 'ssh:devbox' }, remotes, 'claude')).toEqual({ name: 'devbox', def });
    expect(sshRemoteFor({ claude: 'ssh:devbox' }, remotes, 'claude', 'host')).toBeUndefined();
    expect(sshRemoteFor({ claude: 'host' }, remotes, 'claude')).toBeUndefined();
    expect(sshRemoteFor({ claude: 'ssh:missing' }, remotes, 'claude')).toBeUndefined();
    expect(sshRemoteFor(undefined, remotes, 'claude')).toBeUndefined();
  });
});

describe('confirmRemoteTrust', () => {
  const remote = { name: 'devbox', def };

  it('asks nothing when the record matches and writes nothing', async () => {
    const confirm = vi.fn(async () => true);
    const record = vi.fn(async () => undefined);
    const trust = { devbox: remoteTrustKey('devbox', def) };
    await expect(confirmRemoteTrust({ storageDir: '/d', confirm, record, trust: () => trust }, remote)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('asks once for a changed field, names every field, and records on allow', async () => {
    const confirm = vi.fn(async () => true);
    const record = vi.fn(async () => undefined);
    const stale = { devbox: remoteTrustKey('devbox', { ...def, host: 'old.example.com' }) };
    await expect(confirmRemoteTrust({ storageDir: '/d', confirm, record, trust: () => stale }, remote)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('devbox'), expect.stringContaining('karst@devbox.example.com:2222'));
    expect(record).toHaveBeenCalledWith('/d', 'devbox', def, undefined);
  });

  it('a decline stores nothing and reports not trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-confirm-'));
    const confirm = vi.fn(async () => false);
    await expect(confirmRemoteTrust({ storageDir: dir, confirm }, remote)).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readRemoteTrust(dir)).toEqual({});
  });

  it('an allow through the real writer makes the remote trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-confirm-'));
    const confirm = vi.fn(async () => true);
    await expect(confirmRemoteTrust({ storageDir: dir, confirm }, remote)).resolves.toBe(true);
    expect(readRemoteTrust(dir)).toEqual({ devbox: remoteTrustKey('devbox', def) });
    // A second launch asks nothing.
    const again = vi.fn(async () => true);
    await expect(confirmRemoteTrust({ storageDir: dir, confirm: again }, remote)).resolves.toBe(true);
    expect(again).not.toHaveBeenCalled();
    expect(readRemoteTrust(dir)).toEqual({ devbox: remoteTrustKey('devbox', def) });
  });
});
