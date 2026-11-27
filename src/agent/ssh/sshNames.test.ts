import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SshCore } from '../sandboxCores.js';
import { SANDBOX_NAME_RE, readExistingInstallId, readOrCreateInstallId, sshProjectPrefix, sshSandboxName } from './sshNames.js';

const PROJECT = '/Users/nick/projects/karst';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-names-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sshSandboxName', () => {
  it('two install ids give two names for one project path', () => {
    const a = sshSandboxName(PROJECT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 555, 'claude');
    const b = sshSandboxName(PROJECT, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 555, 'claude');
    expect(a).not.toBe(b);
    expect(sshProjectPrefix(PROJECT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).not.toBe(
      sshProjectPrefix(PROJECT, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    );
  });

  it('names the same project+install+ticket+core identically every time', () => {
    const id = 'cccccccccccccccccccccccccccccccc';
    expect(sshSandboxName(PROJECT, id, 42, 'codex')).toBe(sshSandboxName(PROJECT, id, 42, 'codex'));
  });

  it('matches SANDBOX_NAME_RE and starts with the project prefix', () => {
    const id = 'dddddddddddddddddddddddddddddddd';
    for (const core of ['claude', 'codex', 'opencode', 'opencode2'] as const) {
      const name = sshSandboxName(PROJECT, id, 1389, core);
      expect(name).toMatch(SANDBOX_NAME_RE);
      expect(name.startsWith(sshProjectPrefix(PROJECT, id))).toBe(true);
      expect(name.endsWith(`-1389-${core}`)).toBe(true);
    }
  });

  it('the prefix is karst- plus 8 lowercase hex digits', () => {
    expect(sshProjectPrefix(PROJECT, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')).toMatch(/^karst-[0-9a-f]{8}$/);
  });

  it('throws for a core the ssh backend cannot host', () => {
    const id = 'ffffffffffffffffffffffffffffffff';
    expect(() => sshSandboxName(PROJECT, id, 7, 'agy' as SshCore)).toThrow(/core/);
  });

  it('throws for a ticket id that is not a positive integer', () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => sshSandboxName(PROJECT, id, 0, 'claude')).toThrow(/ticket id/);
    expect(() => sshSandboxName(PROJECT, id, 1.5, 'claude')).toThrow(/ticket id/);
  });
});

describe('readExistingInstallId (D826)', () => {
  it('is undefined before a launch creates the id, and creates nothing', async () => {
    const storage = tempDir();
    expect(await readExistingInstallId(storage)).toBeUndefined();
    expect(await readExistingInstallId(storage)).toBeUndefined();
    const created = await readOrCreateInstallId(storage);
    expect(await readExistingInstallId(storage)).toBe(created);
  });
});

describe('readOrCreateInstallId', () => {
  it('creates the id once and reuses it on every later read', async () => {
    const storage = tempDir();
    const first = await readOrCreateInstallId(storage);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    const second = await readOrCreateInstallId(storage);
    expect(second).toBe(first);
    const file = join(storage, 'ssh', 'install-id');
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
  });

  it('stores the file 0600', async () => {
    const storage = tempDir();
    await readOrCreateInstallId(storage);
    const mode = statSync(join(storage, 'ssh', 'install-id')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('a concurrent creator wins: the second caller reads the first id', async () => {
    const storage = tempDir();
    const [a, b] = await Promise.all([
      readOrCreateInstallId(storage),
      readOrCreateInstallId(storage),
    ]);
    expect(a).toBe(b);
  });
});
