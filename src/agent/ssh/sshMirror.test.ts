import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { MIRROR_MAX_BYTES } from '../bridge/mirror.js';
import { recordRemoteTrust } from './remoteTrust.js';
import { fakeSshProcess } from './fakeSshProcess.js';
import {
  isValidMirrorRel,
  mirrorBridgeMirrors,
  mirrorScript,
  mirrorToRemote,
  type MirrorRemote,
  type SshMirrorDeps,
} from './sshMirror.js';

const def: RemoteDef = {
  host: 'devbox.example.com',
  user: 'karst',
  port: 2222,
  keyPath: '~/.ssh/id_ed25519',
  mode: 'direct',
  remoteDir: '/srv/karst',
};
const remote: MirrorRemote = { name: 'devbox', def };
const RUN_DIR = '/srv/karst/karst-1234abcd-7-opencode2/bridge/7';
const CONTROL = { ok: true as const };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'karst-ssh-mirror-'));
}

async function trustedDeps(ssh = fakeSshProcess()): Promise<{ deps: SshMirrorDeps; ssh: ReturnType<typeof fakeSshProcess> }> {
  const trustDir = tempDir();
  await recordRemoteTrust(trustDir, remote.name, def);
  return {
    deps: { trustDir, ssh, controlDir: '/tmp/karst-ssh-test/', ensureControlDir: async () => CONTROL },
    ssh,
  };
}

describe('mirrorToRemote', () => {
  it('an unconfirmed remote is refused and runs NO ssh', async () => {
    const ssh = fakeSshProcess();
    const out = await mirrorToRemote(remote, RUN_DIR, 'inbox/fix-1.md', 'B', {
      trustDir: tempDir(),
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => CONTROL,
    });
    expect(out).toEqual({ ok: false, reason: 'ssh remote devbox not confirmed' });
    expect(ssh.calls).toEqual([]);
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('refuses a relative path outside the four bridge dirs, without any ssh', async () => {
    const { deps, ssh } = await trustedDeps();
    for (const rel of ['../secret', 'results/../x.json', 'inbox/../x.md', 'other/x', '/results/x.json', 'results/x.txt', 'inbox/a/b.md', 'logs/']) {
      const out = await mirrorToRemote(remote, RUN_DIR, rel, 'B', deps);
      expect(out.ok, rel).toBe(false);
    }
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('accepts exactly the four safe forms', () => {
    for (const rel of ['results/abc_1.json', 'inbox/fix-12.md', 'attachments/scan.png', 'logs/gate.log']) {
      expect(isValidMirrorRel(rel), rel).toBe(true);
    }
  });

  it('writes by stdin into the remote run dir, atomically', async () => {
    const { deps, ssh } = await trustedDeps();
    const out = await mirrorToRemote(remote, RUN_DIR, 'inbox/fix-7.md', 'BRIEF BODY', deps);
    expect(out).toEqual({ ok: true });
    expect(ssh.stdinCalls).toHaveLength(1);
    const call = ssh.stdinCalls[0]!;
    expect(call.stdin.toString('utf8')).toBe('BRIEF BODY');
    // D554 argv: hardened options, `--`, destination, then ONE `sh -c` script.
    expect(call.args.slice(-2, -1)).toEqual(['karst@devbox.example.com']);
    expect(call.args).toContain('--');
    const script = call.args.at(-1)!;
    expect(script).toContain('sh -c');
    expect(script).toContain(`${RUN_DIR}/inbox/fix-7.md`);
    expect(script).toContain('cat >');
    expect(script).toContain('mv -f');
  });

  it('carries a marker reply to results/<seq>.json', async () => {
    const { deps, ssh } = await trustedDeps();
    const out = await mirrorToRemote(remote, RUN_DIR, 'results/9f2a.json', '{"v":1,"ok":true}', deps);
    expect(out).toEqual({ ok: true });
    expect(ssh.stdinCalls[0]!.args.at(-1)).toContain(`${RUN_DIR}/results/9f2a.json`);
  });

  it('a non-zero remote exit is ok:false with the remote reason', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-mirror': { code: 1, stderr: 'mkdir: disk full' } });
    const { deps } = await trustedDeps(ssh);
    const out = await mirrorToRemote(remote, RUN_DIR, 'logs/gate.log', 'X', deps);
    expect(out).toEqual({ ok: false, reason: 'ssh devbox: mirror logs/gate.log failed (exit 1): mkdir: disk full' });
  });

  it('a transport failure is ok:false and never claims a write', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-mirror': { transport: true, stderr: 'connect: no route' } });
    const { deps } = await trustedDeps(ssh);
    const out = await mirrorToRemote(remote, RUN_DIR, 'attachments/a.png', 'X', deps);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain('transport failed');
  });

  it('a control dir that is not private refuses before any ssh', async () => {
    const ssh = fakeSshProcess();
    const { deps } = await trustedDeps(ssh);
    const out = await mirrorToRemote(remote, RUN_DIR, 'inbox/fix-1.md', 'B', {
      ...deps,
      ensureControlDir: async () => ({ ok: false, reason: 'ssh: control dir /tmp/karst-ssh-test/ is not private' }),
    });
    expect(out).toEqual({ ok: false, reason: 'ssh: control dir /tmp/karst-ssh-test/ is not private' });
    expect(ssh.stdinCalls).toEqual([]);
  });
});

describe('mirrorScript', () => {
  it('quotes the target and keeps a failure trap', () => {
    const script = mirrorScript('/srv/karst/ws/bridge/7', 'inbox/fix-1.md');
    expect(script).toContain(`d='/srv/karst/ws/bridge/7/inbox'`);
    expect(script).toContain(`t='/srv/karst/ws/bridge/7/inbox/fix-1.md'.tmp.$$`);
    expect(script).toContain("trap 'rm -f \"$t\"' EXIT");
  });
});

describe('mirrorBridgeMirrors (D556 edit 5)', () => {
  /** A host bridge dir with one binary attachment, one log, a link and an oversized file. */
  const hostBridge = (): string => {
    const dir = tempDir();
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'attachments', 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    writeFileSync(join(dir, 'logs', 'gate.log'), 'gate output\n');
    symlinkSync('/etc/hosts', join(dir, 'attachments', 'link.png'));
    writeFileSync(join(dir, 'logs', 'huge.log'), Buffer.alloc(MIRROR_MAX_BYTES + 1, 0x61));
    return dir;
  };

  it('an unconfirmed remote is refused and makes ZERO ssh calls', async () => {
    const ssh = fakeSshProcess();
    const out = await mirrorBridgeMirrors(remote, RUN_DIR, hostBridge(), {
      trustDir: tempDir(),
      ssh,
      controlDir: '/tmp/karst-ssh-test/',
      ensureControlDir: async () => CONTROL,
    });
    expect(out).toEqual({ ok: false, reason: 'ssh remote devbox not confirmed', mirrored: [], skipped: [] });
    expect(ssh.calls).toEqual([]);
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('copies attachments and logs byte-for-byte and skips a link and an oversized file', async () => {
    const { deps, ssh } = await trustedDeps();
    const out = await mirrorBridgeMirrors(remote, RUN_DIR, hostBridge(), deps);
    expect(out.ok).toBe(true);
    expect(out.mirrored).toEqual(['attachments/scan.png', 'logs/gate.log']);
    expect([...out.skipped].sort()).toEqual(['huge.log', 'link.png']);
    expect(ssh.stdinCalls.map((c) => c.args.at(-1))).toEqual([
      expect.stringContaining(`${RUN_DIR}/attachments/scan.png`),
      expect.stringContaining(`${RUN_DIR}/logs/gate.log`),
    ]);
    // The attachment's bytes are unchanged (a utf8 round trip would corrupt them).
    expect([...ssh.stdinCalls[0]!.stdin]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  it('a refused copy stops the mirror and reports the remote reason', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-mirror': { code: 1, stderr: 'disk full' } });
    const { deps } = await trustedDeps(ssh);
    const out = await mirrorBridgeMirrors(remote, RUN_DIR, hostBridge(), deps);
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('disk full') });
  });

  it('a missing host mirror dir is an empty success with no ssh call', async () => {
    const { deps, ssh } = await trustedDeps();
    const out = await mirrorBridgeMirrors(remote, RUN_DIR, tempDir(), deps);
    expect(out).toEqual({ ok: true, mirrored: [], skipped: [] });
    expect(ssh.stdinCalls).toEqual([]);
  });
});
