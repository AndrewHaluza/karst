import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeSshProcess } from './fakeSshProcess.js';
import { foreignListScript, listForeignRemoteDirs, parseForeignListing, removeForeignRemoteDir, type ForeignRemoveContext } from './sshForeign.js';
import { REMOTE_TRUST_FILE, remoteTrustKey } from './remoteTrust.js';
import { sshProjectPrefix } from './sshNames.js';
import type { RemoteDef } from '../../manifest/types.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const PREFIX = sshProjectPrefix('/p', INSTALL_ID);
const FOREIGN = 'karst-aaaaaaaa-1-claude';
const OWN = `${PREFIX}-2-claude`;

function trustDir(entries: Record<string, string> = { devbox: remoteTrustKey('devbox', REMOTE) }): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-foreign-'));
  writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify(entries));
  return dir;
}

function ctx(dir = trustDir()): ForeignRemoveContext {
  return { controlDir: '/tmp/karst-ssh-test/', trustDir: dir, projectRoot: '/p', installId: INSTALL_ID, now: () => 1_800_000_000_000 };
}

/** One `name\tmtime\tkb\tlastCommit\tunmerged\ttmux` line of the foreign listing. */
function line(name: string, over: { mtime?: number; kb?: number; last?: string; unmerged?: number | string; tmux?: 'yes' | 'no' } = {}): string {
  return [name, over.mtime ?? 1_799_900_000, over.kb ?? 2048, over.last ?? '2026-11-01T10:00:00+00:00', over.unmerged ?? 0, over.tmux ?? 'no'].join('\t');
}

describe('listForeignRemoteDirs (D824, edit 13)', () => {
  it('lists karst-* dirs that are not this install\'s prefix, with age, size, last commit and unmerged count', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-foreign-list': { stdout: `${line(FOREIGN, { unmerged: 3, tmux: 'yes' })}\n${line(OWN)}\nother-dir\t1\t1\t-\t0\tno\n` } });
    const r = await listForeignRemoteDirs(ssh, 'devbox', REMOTE, ctx());
    expect(r.error).toBeUndefined();
    expect(r.dirs).toEqual([{
      name: FOREIGN,
      path: `/srv/karst/${FOREIGN}`,
      ageDays: 1,
      sizeKb: 2048,
      lastCommit: '2026-11-01T10:00:00+00:00',
      unmergedCommits: 3,
      tmux: true,
    }]);
  });

  it('a failed git probe of a clone is an unknown unmerged count, never 0', () => {
    const now = 1_800_000_000_000;
    const counts = ['?', '', 'x', '-1', '1.5'].map((u) => parseForeignListing(line(FOREIGN, { unmerged: u }), REMOTE, now)[0]!.unmergedCommits);
    expect(counts).toEqual([null, null, null, null, null]);
    expect(parseForeignListing(line(FOREIGN, { unmerged: 0 }), REMOTE, now)[0]!.unmergedCommits).toBe(0);
    expect(parseForeignListing(line(FOREIGN, { unmerged: 2 }), REMOTE, now)[0]!.unmergedCommits).toBe(2);
    expect(parseForeignListing([FOREIGN, '1', '1', '-'].join('\t'), REMOTE, now)[0]!.unmergedCommits).toBeNull();
  });

  it('the listing script prints 0 only when there is no clone, and ? when git fails on a clone', () => {
    const script = foreignListScript('/srv/karst');
    expect(script).toContain(`  if [ -d "$p/repo" ]; then c=$(git -C "$p/repo" rev-list --count HEAD --not '--glob=refs/karst/base/*' 2>/dev/null || echo '?'); else c=0; fi`);
    expect(script).not.toContain("base/*' 2>/dev/null || echo 0");
  });

  it('an unconfirmed remote runs no ssh call and reports it', async () => {
    const ssh = fakeSshProcess();
    const r = await listForeignRemoteDirs(ssh, 'devbox', REMOTE, ctx(trustDir({})));
    expect(ssh.calls).toEqual([]);
    expect(r.dirs).toEqual([]);
    expect(r.error).toBe('ssh devbox: ssh remote devbox not confirmed');
  });

  it('a failed listing is an error, never foreign dirs', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-foreign-list': { code: 255, transport: true, stderr: 'connection refused' } });
    const r = await listForeignRemoteDirs(ssh, 'devbox', REMOTE, ctx());
    expect(r.dirs).toEqual([]);
    expect(r.error).toContain('ssh devbox:');
  });
});

describe('removeForeignRemoteDir (D824, edit 13)', () => {
  const remove = (ssh: ReturnType<typeof fakeSshProcess>, name: string, confirmed = true, c = ctx(), def = REMOTE) =>
    removeForeignRemoteDir(ssh, 'devbox', def, name, confirmed, c);

  it('refuses without confirmed, for a name with this install\'s prefix and for a bad name: zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    await expect(remove(ssh, FOREIGN, false)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('not confirmed by the user') });
    await expect(remove(ssh, OWN)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('not foreign') });
    await expect(remove(ssh, 'karst-junk')).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('not a sandbox name') });
    expect(ssh.calls).toEqual([]);
  });

  it('refuses an unsafe remoteDir and an untrusted remote: zero ssh calls', async () => {
    const ssh = fakeSshProcess();
    const unsafe = { ...REMOTE, remoteDir: '/srv' };
    await expect(remove(ssh, FOREIGN, true, ctx(trustDir({ devbox: remoteTrustKey('devbox', unsafe) })), unsafe)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('remoteDir') });
    await expect(remove(ssh, FOREIGN, true, ctx(trustDir({})))).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('not confirmed') });
    expect(ssh.calls).toEqual([]);
  });

  it('deletes exactly <remoteDir>/<name> in one call that re-lists the dir first', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-foreign-remove': { code: 0 } });
    await expect(remove(ssh, FOREIGN)).resolves.toEqual({ ok: true });
    expect(ssh.calls).toHaveLength(1);
    const script = ssh.calls[0]!.args.at(-1) ?? '';
    expect(script).toContain('karst-ssh-foreign-remove');
    expect(script).toContain('ls -1');
    expect(script).toContain("'/srv/karst'");
    expect(script).toContain('rm -rf --');
    expect(script).toContain(`/srv/karst/${FOREIGN}`);
    // Never the D555 prefix-guarded dispose.
    expect(script).not.toContain('karst-ssh-dispose');
  });

  it('a name no longer in the fresh listing is refused by the remote script', async () => {
    const ssh = fakeSshProcess({ 'karst-ssh-foreign-remove': { code: 3, stderr: 'gone' } });
    await expect(remove(ssh, FOREIGN)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('not in the fresh listing') });
    expect(ssh.calls).toHaveLength(1);
  });
});
