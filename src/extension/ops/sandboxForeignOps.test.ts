import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { REMOTE_TRUST_FILE, remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import type { RemoteDef } from '../../manifest/types.js';
import { CANCEL } from './sandboxLifecycleOps.js';
import { cleanupForeignRemoteOp, REMOVE_FOREIGN, type ForeignPickItem, type SandboxForeignDeps } from './sandboxForeignOps.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const FOREIGN = 'karst-aaaaaaaa-1-claude';

function trust(entries: Record<string, string> = { devbox: remoteTrustKey('devbox', REMOTE) }): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-foreign-ops-'));
  writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify(entries));
  return dir;
}

function line(name: string, over: { unmerged?: number; tmux?: 'yes' | 'no'; last?: string } = {}): string {
  return [name, 1_799_900_000, 1024, over.last ?? '2026-11-01T10:00:00+00:00', over.unmerged ?? 0, over.tmux ?? 'no'].join('\t');
}

function notify() {
  return {
    info: vi.fn<(message: string, ticketId?: number) => void>(),
    warn: vi.fn<(message: string, ticketId?: number) => void>(),
    error: vi.fn(async (_message: string, _ticketId?: number) => {}),
  };
}

function deps(over: Partial<SandboxForeignDeps> = {}) {
  const ssh = fakeSshProcess({
    'karst-ssh-foreign-list': { stdout: `${line(FOREIGN)}\n` },
    'tmux kill-session': { code: 0 },
    'karst-ssh-foreign-remove': { code: 0 },
  });
  const pick = vi.fn(async (_items: readonly ForeignPickItem[]) => [`devbox\u0000${FOREIGN}`] as readonly string[] | undefined);
  const choose = vi.fn(async (_message: string, _choices: readonly string[]) => REMOVE_FOREIGN as string | undefined);
  const n = notify();
  const d: SandboxForeignDeps = {
    projectRoot: '/p', remotes: () => ({ devbox: REMOTE }), installId: () => INSTALL_ID, globalStorageDir: trust(),
    ssh, controlDir: '/tmp/karst-ssh-test/', pick, choose, notify: n, now: () => 1_800_000_000_000,
    ...over,
  };
  return { d, ssh, pick: d.pick as typeof pick, choose: d.choose as typeof choose, n };
}

const scripts = (ssh: ReturnType<typeof fakeSshProcess>): string[] => ssh.calls.map((c) => c.args.at(-1) ?? '');

describe('cleanupForeignRemoteOp (D824, edit 13)', () => {
  it('offers every foreign dir in a multi-select pick with nothing preselected', async () => {
    const { d, pick } = deps({ pick: vi.fn(async (_items: readonly ForeignPickItem[]) => undefined) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    const items = pick.mock.calls[0]![0] as readonly ForeignPickItem[];
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(`devbox\u0000${FOREIGN}`);
    expect(items[0]!.label).toContain(`devbox: /srv/karst/${FOREIGN}`);
    expect(items[0]!.description).toContain('2026-11-01T10:00:00+00:00');
    expect(items[0]!.description).toContain('0 commit');
    expect('picked' in items[0]!).toBe(false);
  });

  it('a dismissed or empty pick deletes nothing', async () => {
    const dismissed = deps({ pick: vi.fn(async () => undefined) });
    await expect(cleanupForeignRemoteOp(dismissed.d)).resolves.toBe(0);
    expect(scripts(dismissed.ssh).some((s) => s.includes('foreign-remove') || s.includes('kill-session'))).toBe(false);

    const empty = deps({ pick: vi.fn(async () => [] as readonly string[]) });
    await expect(cleanupForeignRemoteOp(empty.d)).resolves.toBe(0);
    expect(empty.choose).not.toHaveBeenCalled();
    expect(scripts(empty.ssh).some((s) => s.includes('foreign-remove') || s.includes('kill-session'))).toBe(false);
  });

  it('a confirmed dir gets tmux kill-session first, then the exact-path guarded delete', async () => {
    const { d, ssh } = deps();
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(1);
    const s = scripts(ssh);
    const kill = s.findIndex((x) => x.includes('tmux kill-session'));
    const remove = s.findIndex((x) => x.includes('karst-ssh-foreign-remove'));
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(kill);
    expect(s[remove]).toContain('rm -rf --');
    expect(s[remove]).toContain(`/srv/karst/${FOREIGN}`);
    // The D555 prefix-guarded dispose is never used for a foreign dir.
    expect(s.every((x) => !x.includes('karst-ssh-dispose'))).toBe(true);
  });

  it('a dir with commits not in refs/karst/base/* needs a second confirm; cancel keeps it', async () => {
    const { d, choose, ssh } = deps({
      ssh: fakeSshProcess({
        'karst-ssh-foreign-list': { stdout: `${line(FOREIGN, { unmerged: 2 })}\n` },
        'karst-ssh-foreign-remove': { code: 0 },
        'tmux kill-session': { code: 0 },
      }),
      choose: vi.fn()
        .mockResolvedValueOnce(REMOVE_FOREIGN as string | undefined)
        .mockResolvedValueOnce(CANCEL as string | undefined),
    });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(choose).toHaveBeenCalledTimes(2);
    expect(choose.mock.calls[1]![0]).toContain('2 commit');
    expect(scripts(ssh).some((s) => s.includes('foreign-remove') || s.includes('kill-session'))).toBe(false);
  });

  it('a dir with a live tmux session needs a second modal', async () => {
    const { d, choose } = deps({
      ssh: fakeSshProcess({
        'karst-ssh-foreign-list': { stdout: `${line(FOREIGN, { tmux: 'yes' })}\n` },
        'karst-ssh-foreign-remove': { code: 0 },
        'tmux kill-session': { code: 0 },
      }),
      choose: vi.fn(async (_message: string, _choices: readonly string[]) => REMOVE_FOREIGN as string | undefined),
    });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(1);
    expect(choose).toHaveBeenCalledTimes(2);
    expect(choose.mock.calls[1]![0]).toContain('tmux session');
  });

  it('a refused delete is reported and not counted', async () => {
    const { d, n } = deps({
      ssh: fakeSshProcess({
        'karst-ssh-foreign-list': { stdout: `${line(FOREIGN)}\n` },
        'tmux kill-session': { code: 0 },
        'karst-ssh-foreign-remove': { code: 3, stderr: 'gone' },
      }),
    });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(n.warn).toHaveBeenCalledWith(expect.stringContaining('was not removed'));
  });

  it('an unconfirmed remote runs zero ssh calls and never opens the picker', async () => {
    const { d, ssh, pick, n } = deps({ globalStorageDir: trust({}) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(ssh.calls).toEqual([]);
    expect(pick).not.toHaveBeenCalled();
    expect(n.warn).toHaveBeenCalledWith('karst: ssh devbox: ssh remote devbox not confirmed');
  });
});
