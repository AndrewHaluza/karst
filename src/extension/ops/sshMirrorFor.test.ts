import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import { recordRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { makeTicketMirror } from './sshMirrorFor.js';

const def: RemoteDef = {
  host: 'devbox.example.com',
  user: 'karst',
  port: 22,
  mode: 'direct',
  remoteDir: '/srv/karst',
};
const SSH_PLACEMENT: TicketPlacement = { backend: 'ssh', core: 'opencode2', sandboxName: 'devbox/karst-1234abcd-7-opencode2', reason: null };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'karst-ssh-mirror-for-'));
}

describe('makeTicketMirror', () => {
  it('a host placement is a no-op success and makes no ssh call', async () => {
    const ssh = fakeSshProcess();
    const mirror = makeTicketMirror({
      trustDir: tempDir(),
      placementOf: () => ({ backend: 'host', core: null, sandboxName: null, reason: null }),
      remotes: () => ({ devbox: def }),
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => ({ ok: true as const }),
    });
    await expect(mirror(7, 'results/abc.json', '{}')).resolves.toEqual({ ok: true });
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('RESULT FILE: an unconfirmed remote makes ZERO ssh calls and reports the trust refusal', async () => {
    const ssh = fakeSshProcess();
    const mirror = makeTicketMirror({
      trustDir: tempDir(),
      placementOf: () => SSH_PLACEMENT,
      remotes: () => ({ devbox: def }),
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => ({ ok: true as const }),
    });
    await expect(mirror(7, 'results/abc.json', '{"v":1}')).resolves.toEqual({ ok: false, reason: 'ssh remote devbox not confirmed' });
    expect(ssh.calls).toEqual([]);
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('a confirmed remote writes the reply under <remoteDir>/<sandbox>/bridge/<ticketId>/results', async () => {
    const ssh = fakeSshProcess();
    const trustDir = tempDir();
    await recordRemoteTrust(trustDir, 'devbox', def);
    const mirror = makeTicketMirror({
      trustDir,
      placementOf: () => SSH_PLACEMENT,
      remotes: () => ({ devbox: def }),
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => ({ ok: true as const }),
    });
    await expect(mirror(7, 'results/abc.json', '{"v":1}')).resolves.toEqual({ ok: true });
    expect(ssh.stdinCalls[0]!.stdin.toString('utf8')).toBe('{"v":1}');
    expect(ssh.stdinCalls[0]!.args.at(-1)).toContain(
      '/srv/karst/karst-1234abcd-7-opencode2/bridge/7/results/abc.json',
    );
  });

  it('a remote removed from karst.yml is refused without an ssh call', async () => {
    const ssh = fakeSshProcess();
    const mirror = makeTicketMirror({
      trustDir: tempDir(),
      placementOf: () => SSH_PLACEMENT,
      remotes: () => undefined,
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => ({ ok: true as const }),
    });
    await expect(mirror(7, 'inbox/fix-1.md', 'B')).resolves.toEqual({ ok: false, reason: 'ssh remote devbox not in karst.yml' });
    expect(ssh.stdinCalls).toEqual([]);
  });
});
