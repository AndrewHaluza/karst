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
import { listForeignRemoteDirs } from '../../agent/ssh/sshForeign.js';
import { sshControlDir } from '../../agent/ssh/sshControlDir.js';

// Pass-through spies: a test reads the exact context the op hands to the listing.
vi.mock('../../agent/ssh/sshForeign.js', async (orig) => {
  const m = await orig<typeof import('../../agent/ssh/sshForeign.js')>();
  return { ...m, listForeignRemoteDirs: vi.fn(m.listForeignRemoteDirs) };
});

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const FOREIGN = 'karst-aaaaaaaa-1-claude';

function trust(entries: Record<string, string> = { devbox: remoteTrustKey('devbox', REMOTE) }): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-foreign-ops-'));
  writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify(entries));
  return dir;
}

function line(name: string, over: { unmerged?: number | string; tmux?: 'yes' | 'no'; last?: string } = {}): string {
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

  it('a dir whose clone git cannot read needs the second confirm and says the count is unknown; cancel keeps it', async () => {
    const { d, choose, pick, ssh } = deps({
      ssh: fakeSshProcess({
        'karst-ssh-foreign-list': { stdout: `${line(FOREIGN, { unmerged: '?' })}\n` },
        'karst-ssh-foreign-remove': { code: 0 },
        'tmux kill-session': { code: 0 },
      }),
      choose: vi.fn()
        .mockResolvedValueOnce(REMOVE_FOREIGN as string | undefined)
        .mockResolvedValueOnce(CANCEL as string | undefined),
    });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    const path = `/srv/karst/${FOREIGN}`;
    expect(pick.mock.calls[0]![0][0]!.description).toBe('last commit 2026-11-01T10:00:00+00:00 · an unknown number of commits not in refs/karst/base/* · 1 day old · 1 MB');
    expect(choose.mock.calls).toEqual([
      [`Remove 1 foreign remote workspace?\n${path} — last commit 2026-11-01T10:00:00+00:00, an unknown number of commits not in refs/karst/base/*`, [REMOVE_FOREIGN, CANCEL]],
      [`1 foreign workspace has commits not in refs/karst/base/*, which the removal loses:\n${path} — an unknown number of commits (git cannot read the clone)`, [REMOVE_FOREIGN, CANCEL]],
    ]);
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
    expect(n.warn).toHaveBeenCalledWith('ssh devbox: ssh remote devbox not confirmed');
  });
});

describe('cleanupForeignRemoteOp: exact texts, guards and context', () => {
  const NOW_S = 1_800_000_000;
  const A = 'karst-aaaaaaaa-1-claude';
  const B = 'karst-bbbbbbbb-2-codex';
  /** `name mtime kb last unmerged tmux`, with the age in whole days before the pinned now. */
  const row = (name: string, days: number, kb: number, last: string, unmerged: number, tmux: 'yes' | 'no'): string =>
    [name, NOW_S - days * 86_400, kb, last, unmerged, tmux].join('\t');
  const twoDirs = (rows: string): ReturnType<typeof fakeSshProcess> => fakeSshProcess({
    'karst-ssh-foreign-list': { stdout: rows },
    'tmux kill-session': { code: 0 },
    'karst-ssh-foreign-remove': { code: 0 },
  });
  const ROWS = `${row(A, 1, 1024, '2026-11-01T10:00:00+00:00', 1, 'yes')}\n${row(B, 2, 100, '-', 2, 'no')}\n`;
  const PATH_A = `/srv/karst/${A}`;
  const PATH_B = `/srv/karst/${B}`;
  const LINE_A = `${PATH_A} — last commit 2026-11-01T10:00:00+00:00, 1 commit not in refs/karst/base/*`;
  const LINE_B = `${PATH_B} — last commit none, 2 commits not in refs/karst/base/*`;

  it('a project with no remotes reports it and runs no ssh', async () => {
    for (const remotes of [() => undefined, () => ({})]) {
      const { d, ssh, n, pick } = deps({ remotes });
      await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
      expect(n.info).toHaveBeenCalledWith('This project declares no ssh remotes.');
      expect(n.info).toHaveBeenCalledTimes(1);
      expect(ssh.calls).toEqual([]);
      expect(pick).not.toHaveBeenCalled();
    }
  });

  it('a missing install id reports it and runs no ssh', async () => {
    const { d, ssh, n, pick } = deps({ installId: () => undefined });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(n.info).toHaveBeenCalledWith('The ssh install id is not available, so no remote workspace can be classified.');
    expect(n.info).toHaveBeenCalledTimes(1);
    expect(ssh.calls).toEqual([]);
    expect(pick).not.toHaveBeenCalled();
  });

  it('an empty listing reports that no foreign workspace was found', async () => {
    const { d, n, pick } = deps({ ssh: twoDirs('') });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(n.info).toHaveBeenCalledWith('No foreign remote workspace was found.');
    expect(n.warn).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  });

  it('offers each dir with its exact label, description and detail, and no warning', async () => {
    const { d, pick, n } = deps({ ssh: twoDirs(ROWS), pick: vi.fn(async (_items: readonly ForeignPickItem[]) => undefined) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(pick).toHaveBeenCalledWith([
      {
        id: `devbox\u0000${A}`, label: `devbox: ${PATH_A}`,
        description: 'last commit 2026-11-01T10:00:00+00:00 · 1 commit not in refs/karst/base/* · 1 day old · 1 MB',
        detail: 'a live tmux session uses it',
      },
      {
        id: `devbox\u0000${B}`, label: `devbox: ${PATH_B}`,
        description: 'last commit none · 2 commits not in refs/karst/base/* · 2 days old · 100 kB',
        detail: undefined,
      },
    ], 'Select foreign remote workspaces to remove');
    expect(n.warn).not.toHaveBeenCalled();
  });

  it('a pick that matches no listed dir removes nothing and asks nothing', async () => {
    const ssh = twoDirs(ROWS);
    const { d, choose } = deps({ ssh, pick: vi.fn(async () => ['devbox\u0000karst-zzzzzzzz-9-claude'] as readonly string[]) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(choose).not.toHaveBeenCalled();
    expect(scripts(ssh).some((s) => s.includes('foreign-remove') || s.includes('kill-session'))).toBe(false);
  });

  it('removes only the picked dir, with exact confirms, kill bound, debug line and summary', async () => {
    const debug = vi.fn();
    const ssh = twoDirs(ROWS);
    const { d, choose, n } = deps({ ssh, pick: vi.fn(async () => [`devbox\u0000${B}`] as readonly string[]), debug });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(1);
    expect(choose.mock.calls).toEqual([
      [`Remove 1 foreign remote workspace?\n${LINE_B}`, [REMOVE_FOREIGN, CANCEL]],
      [`1 foreign workspace has commits not in refs/karst/base/*, which the removal loses:\n${PATH_B} — 2 commits`, [REMOVE_FOREIGN, CANCEL]],
    ]);
    const kill = ssh.calls.find((c) => { const s = c.args.at(-1) ?? ''; return s.includes('tmux kill-session') && !s.includes('karst-ssh-foreign'); });
    expect(kill?.opts).toEqual({ maxStdoutBytes: 1024 });
    expect(scripts(ssh).filter((s) => s.includes('tmux kill-session')).every((s) => s.includes(B) && !s.includes(A))).toBe(true);
    expect(debug).toHaveBeenCalledWith(`[ssh devbox] removed foreign workspace ${PATH_B}`);
    expect(n.info).toHaveBeenCalledWith('Removed 1 foreign remote workspace.');
  });

  it('two picked dirs get plural confirms, the unmerged and the live modal, and a plural summary', async () => {
    const { d, choose, n } = deps({ ssh: twoDirs(ROWS), pick: vi.fn(async () => [`devbox\u0000${A}`, `devbox\u0000${B}`] as readonly string[]) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(2);
    expect(choose.mock.calls.map((c) => c[0])).toEqual([
      `Remove 2 foreign remote workspaces?\n${LINE_A}\n${LINE_B}`,
      `2 foreign workspaces have commits not in refs/karst/base/*, which the removal loses:\n${PATH_A} — 1 commit\n${PATH_B} — 2 commits`,
      `1 foreign workspace has a live tmux session; removing it ends that session:\n${PATH_A}`,
    ]);
    expect(n.info).toHaveBeenCalledWith('Removed 2 foreign remote workspaces.');
  });

  it('two live dirs get the plural live modal; a cancel there removes nothing', async () => {
    const rows = `${row(A, 1, 1024, '-', 0, 'yes')}\n${row(B, 1, 1024, '-', 0, 'yes')}\n`;
    const choose = vi.fn()
      .mockResolvedValueOnce(REMOVE_FOREIGN as string | undefined)
      .mockResolvedValueOnce(CANCEL as string | undefined);
    const ssh = twoDirs(rows);
    const { d } = deps({ ssh, choose, pick: vi.fn(async () => [`devbox\u0000${A}`, `devbox\u0000${B}`] as readonly string[]) });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(choose.mock.calls).toEqual([
      [`Remove 2 foreign remote workspaces?\n${PATH_A} — last commit none, 0 commits not in refs/karst/base/*\n${PATH_B} — last commit none, 0 commits not in refs/karst/base/*`, [REMOVE_FOREIGN, CANCEL]],
      [`2 foreign workspaces have a live tmux session; removing it ends that session:\n${PATH_A}\n${PATH_B}`, [REMOVE_FOREIGN, CANCEL]],
    ]);
    expect(scripts(ssh).some((s) => s.includes('foreign-remove') || s.includes('kill-session'))).toBe(false);
  });

  it('a summary of zero removed dirs is plural', async () => {
    const { d, n } = deps({
      ssh: fakeSshProcess({ 'karst-ssh-foreign-list': { stdout: `${line(FOREIGN)}\n` }, 'karst-ssh-foreign-remove': { code: 3, stderr: 'gone' } }),
    });
    await expect(cleanupForeignRemoteOp(d)).resolves.toBe(0);
    expect(n.info).toHaveBeenCalledWith('Removed 0 foreign remote workspaces.');
  });

  it('hands the listing the exact context: injected controlDir, now and debug only when given', async () => {
    const spy = vi.mocked(listForeignRemoteDirs);
    const debug = vi.fn();
    const now = (): number => NOW_S * 1000;
    const given = deps({ ssh: twoDirs(''), now, debug });
    spy.mockClear();
    await cleanupForeignRemoteOp(given.d);
    expect(spy.mock.calls[0]![3]).toStrictEqual({
      controlDir: '/tmp/karst-ssh-test/', trustDir: given.d.globalStorageDir, projectRoot: '/p', installId: INSTALL_ID, now, debug,
    });

    const { controlDir: _c, now: _n, debug: _d, ...bare } = deps({ ssh: twoDirs('') }).d;
    spy.mockClear();
    await cleanupForeignRemoteOp(bare);
    expect(spy.mock.calls[0]![3]).toStrictEqual({
      controlDir: sshControlDir(), trustDir: bare.globalStorageDir, projectRoot: '/p', installId: INSTALL_ID,
    });
  });

  it('without an injected clock the age comes from the real clock', async () => {
    // A dir modified one day after the real now is 0 days old (never negative).
    const future = Math.floor(Date.now() / 1000) + 86_400;
    const rows = `${[A, future, 1024, '-', 0, 'no'].join('\t')}\n`;
    const { now: _n, ...rest } = deps({ ssh: twoDirs(rows), pick: vi.fn(async (_items: readonly ForeignPickItem[]) => undefined) }).d;
    const pick = rest.pick as ReturnType<typeof vi.fn>;
    await cleanupForeignRemoteOp(rest);
    expect((pick.mock.calls[0]![0] as readonly ForeignPickItem[])[0]!.description).toBe('last commit none · 0 commits not in refs/karst/base/* · 0 days old · 1 MB');
  });
});
