import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_SSH_CONTROL_DEPS,
  ensureSshControlDir,
  sshControlDir,
  type SshControlDeps,
  type SshControlStat,
} from './sshControlDir.js';

const UID = 501;
const PRIVATE_MODE = 0o40700;

interface FakeState {
  readonly dir: boolean;
  readonly link: boolean;
  readonly uid: number;
  readonly mode: number;
}

const state = (over: Partial<FakeState> = {}): FakeState => ({
  dir: true,
  link: false,
  uid: UID,
  mode: PRIVATE_MODE,
  ...over,
});

const toStat = (s: FakeState): SshControlStat => ({
  isDirectory: () => s.dir,
  isSymbolicLink: () => s.link,
  uid: s.uid,
  mode: s.mode,
});

interface FakeDeps extends SshControlDeps {
  readonly made: Array<{ path: string; mode: number; recursive: boolean }>;
  readonly chmods: Array<{ path: string; mode: number }>;
}

/**
 * `initial: null` = missing; `created` = the state `mkdir` produces, so a test
 * can simulate a umask that strips the mode (0700 requested, 0755 made).
 */
function fakeDeps(
  initial: FakeState | null,
  opts: { readonly uid?: number; readonly created?: FakeState; readonly failMkdir?: boolean } = {},
): FakeDeps {
  const made: FakeDeps['made'] = [];
  const chmods: FakeDeps['chmods'] = [];
  let current = initial;
  return {
    uid: opts.uid ?? UID,
    made,
    chmods,
    lstat: () => (current === null
      ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      : Promise.resolve(toStat(current))),
    mkdir: (path, o) => {
      made.push({ path, mode: o.mode, recursive: o.recursive });
      if (opts.failMkdir) return Promise.reject(new Error('EACCES'));
      current = opts.created ?? state();
      return Promise.resolve(path);
    },
    chmod: (path, mode) => {
      chmods.push({ path, mode });
      if (current !== null) current = { ...current, mode: 0o40000 | mode };
      return Promise.resolve();
    },
  };
}

describe('sshControlDir', () => {
  it('is /tmp/karst-ssh-<uid>/ with the trailing slash ControlPath needs', () => {
    expect(sshControlDir(501)).toBe('/tmp/karst-ssh-501/');
    expect(sshControlDir(0)).toBe('/tmp/karst-ssh-0/');
    expect(sshControlDir().startsWith('/tmp/karst-ssh-')).toBe(true);
    expect(sshControlDir().endsWith('/')).toBe(true);
  });

  it('stays under the 104-byte socket path limit with a 40-char %C', () => {
    for (const uid of [0, 501, 1000, 4294967295]) {
      const socket = `${sshControlDir(uid)}${'a'.repeat(40)}`;
      expect(Buffer.byteLength(socket), socket).toBeLessThan(104);
    }
  });
});

describe('ensureSshControlDir', () => {
  const DIR = '/tmp/karst-ssh-501/';

  it('creates a missing directory with mode 0700', async () => {
    const deps = fakeDeps(null);
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({ ok: true });
    expect(deps.made).toEqual([{ path: '/tmp/karst-ssh-501', mode: 0o700, recursive: true }]);
    expect(deps.chmods).toEqual([]);
  });

  it('accepts an existing private directory without touching it', async () => {
    const deps = fakeDeps(state());
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({ ok: true });
    expect(deps.made).toEqual([]);
    expect(deps.chmods).toEqual([]);
  });

  it('tightens the mode of a directory it just created', async () => {
    const deps = fakeDeps(null, { created: state({ mode: 0o40755 }) });
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({ ok: true });
    expect(deps.chmods).toEqual([{ path: '/tmp/karst-ssh-501', mode: 0o700 }]);
  });

  it('fails closed when another uid owns the directory', async () => {
    const deps = fakeDeps(state({ uid: 502 }));
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({ ok: false, reason: `ssh: control dir ${DIR} is not private` });
    expect(deps.chmods).toEqual([]);
  });

  it('fails closed on a symlink, even a private-looking one', async () => {
    await expect(ensureSshControlDir(DIR, fakeDeps(state({ link: true })))).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${DIR} is not private`,
    });
  });

  it('fails closed on a plain file', async () => {
    await expect(ensureSshControlDir(DIR, fakeDeps(state({ dir: false })))).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${DIR} is not private`,
    });
  });

  it('fails closed on a mode that another local user could use', async () => {
    const deps = fakeDeps(state({ mode: 0o40755 }));
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${DIR} is not private`,
    });
    // An existing loose directory is refused, not silently chmodded.
    expect(deps.chmods).toEqual([]);
  });

  it('runs every fs call on the path without the trailing slash', async () => {
    const seen: string[] = [];
    const base = fakeDeps(null, { created: state({ mode: 0o40755 }) });
    const deps: SshControlDeps = {
      ...base,
      lstat: (path) => { seen.push(path); return base.lstat(path); },
    };
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({ ok: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path === '/tmp/karst-ssh-501')).toBe(true);
    expect(base.made).toEqual([{ path: '/tmp/karst-ssh-501', mode: 0o700, recursive: true }]);
    expect(base.chmods).toEqual([{ path: '/tmp/karst-ssh-501', mode: 0o700 }]);
  });

  it('fails closed when the directory cannot be created', async () => {
    const deps = fakeDeps(null, { failMkdir: true });
    await expect(ensureSshControlDir(DIR, deps)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${DIR} is not private`,
    });
  });
});

describe('ensureSshControlDir over the real fs', () => {
  it('creates 0700 and then refuses a loosened mode', async () => {
    const base = mkdtempSync(join(tmpdir(), 'karst-ssh-control-'));
    const dir = join(base, 'karst-ssh-501');
    await expect(ensureSshControlDir(dir, NODE_SSH_CONTROL_DEPS)).resolves.toEqual({ ok: true });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await chmod(dir, 0o755);
    await expect(ensureSshControlDir(dir, NODE_SSH_CONTROL_DEPS)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${dir} is not private`,
    });
  });

  it('refuses a symlink and a file at the path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'karst-ssh-control-'));
    const target = join(base, 'target');
    mkdirSync(target);
    const link = join(base, 'link');
    symlinkSync(target, link);
    await expect(ensureSshControlDir(link, NODE_SSH_CONTROL_DEPS)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${link} is not private`,
    });
    // The default path ends in "/", and lstat of "link/" follows the link.
    await chmod(target, 0o700);
    await expect(ensureSshControlDir(`${link}/`, NODE_SSH_CONTROL_DEPS)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${link}/ is not private`,
    });
    const file = join(base, 'file');
    writeFileSync(file, '');
    await expect(ensureSshControlDir(file, NODE_SSH_CONTROL_DEPS)).resolves.toEqual({
      ok: false,
      reason: `ssh: control dir ${file} is not private`,
    });
  });
});
