import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveBackend } from '../backendResolver.js';
import { HOST_SESSION_RUNNER } from '../sessionRunner.js';
import type { RemoteDef } from '../../manifest/types.js';
import {
  REMOTE_TRUST_FILE,
  isRemoteTrusted,
  readRemoteTrust,
  recordRemoteTrust,
  remoteConfirmDetail,
  remoteConfirmMessage,
  remoteTrustKey,
} from './remoteTrust.js';

const def: RemoteDef = { host: 'devbox.example.com', user: 'karst', port: 2222, keyPath: '~/.ssh/id_ed25519', mode: 'direct', remoteDir: '/srv/karst' };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'karst-ssh-trust-'));
}

describe('remoteTrustKey', () => {
  it('changes when a field that changes what leaves the host changes', () => {
    const base = remoteTrustKey('devbox', def);
    const changed: Partial<RemoteDef>[] = [
      { host: 'other.example.com' },
      { user: 'someone' },
      { port: 22 },
      { keyPath: '~/.ssh/other' },
      { mode: 'docker' },
      { remoteDir: '/home/karst' },
      { allowHostServices: true },
    ];
    for (const patch of changed) {
      expect(remoteTrustKey('devbox', { ...def, ...patch }), JSON.stringify(patch)).not.toBe(base);
    }
    expect(remoteTrustKey('other', def)).not.toBe(base);
    expect(remoteTrustKey('devbox', { ...def })).toBe(base);
    // An absent optional and its explicit false/default forms are the same key.
    expect(remoteTrustKey('devbox', { host: 'h', user: 'u', mode: 'docker', remoteDir: '/srv/x' })).toBe(
      remoteTrustKey('devbox', { host: 'h', user: 'u', mode: 'docker', remoteDir: '/srv/x', allowHostServices: false }),
    );
  });
});

describe('readRemoteTrust / recordRemoteTrust', () => {
  it('reads a missing file as an empty record', () => {
    expect(readRemoteTrust(tempDir())).toEqual({});
  });

  it('reads a corrupt file as empty and warns', () => {
    const dir = tempDir();
    writeFileSync(join(dir, REMOTE_TRUST_FILE), '{ not json');
    const warn = vi.fn();
    expect(readRemoteTrust(dir, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ssh trust'));
  });

  it('writes the record 0600 through a temp file and keeps other remotes', async () => {
    const dir = tempDir();
    await recordRemoteTrust(dir, 'devbox', def);
    await recordRemoteTrust(dir, 'other', { ...def, host: 'other.example.com' });
    const file = join(dir, REMOTE_TRUST_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const trust = readRemoteTrust(dir);
    expect(isRemoteTrusted(trust, 'devbox', def)).toBe(true);
    expect(isRemoteTrusted(trust, 'other', { ...def, host: 'other.example.com' })).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      devbox: remoteTrustKey('devbox', def),
      other: remoteTrustKey('other', { ...def, host: 'other.example.com' }),
    });
  });

  it('an untrusted definition and a changed field are not trusted', () => {
    const trust = { devbox: remoteTrustKey('devbox', def) };
    expect(isRemoteTrusted(trust, 'devbox', def)).toBe(true);
    expect(isRemoteTrusted(trust, 'devbox', { ...def, host: 'evil.example.com' })).toBe(false);
    expect(isRemoteTrusted(trust, 'other', def)).toBe(false);
    expect(isRemoteTrusted({}, 'devbox', def)).toBe(false);
  });
});

describe('the resolve gate', () => {
  const base = { core: 'claude', projectRoot: '/p', ticketId: 1, backends: { claude: 'ssh:devbox' as const } };

  it('an unconfirmed remote resolves to the host and never to a runner', async () => {
    const out = await resolveBackend({ ...base, remoteTrusted: () => false });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toBe("host (ssh: remote 'devbox' not confirmed)");
  });

  it('a confirmed remote still resolves to the host; D553 has no ssh runner yet', async () => {
    const out = await resolveBackend({ ...base, remoteTrusted: () => true });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toBe('host (ssh: backend not available yet)');
    const unconfirmed = await resolveBackend({ ...base, remoteTrusted: () => false });
    expect(out.line).not.toBe(unconfirmed.line);
  });
});

describe('remoteConfirmMessage', () => {
  it('names every field that leaves the host', () => {
    expect(remoteConfirmMessage('devbox', def)).toContain('devbox');
    const detail = remoteConfirmDetail('devbox', def);
    expect(detail).toContain('karst@devbox.example.com:2222');
    expect(detail).toContain('~/.ssh/id_ed25519');
    expect(detail).toContain('direct');
    expect(detail).toContain('/srv/karst');
    expect(detail).toContain('allowHostServices: no');
    expect(remoteConfirmDetail('devbox', { ...def, port: undefined, keyPath: undefined, allowHostServices: true })).toContain('allowHostServices: yes');
  });
});
