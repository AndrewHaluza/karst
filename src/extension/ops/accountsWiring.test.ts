import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fileAccountStore } from '../../agent/accounts/accountStore.js';
import { accountsConfig, resetAccounts, configureRecordedAccountLookup } from '../../agent/accounts/registry.js';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { confirmSessionLaunchIntent, recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { ACCOUNTS_WATCH_MS, binaryResolves, DEFAULT_DIRS, liveAccountNames, lookupAlias, wireAccounts } from './accountsWiring.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'acct-wire-')); });
afterEach(async () => {
  resetAccounts();
  configureRecordedAccountLookup(undefined);
  await rm(root, { recursive: true, force: true });
});

it('publishes the config to the registry on every mutation and on reload', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store });
  expect(accountsConfig()).toEqual({});
  await w.ops.createAccount('codex', 'c', { source: 'folder', dir: '/h/c' });
  await w.ops.setActive('codex', 'c');
  expect(accountsConfig().codex?.active).toBe('c');
  resetAccounts();
  await w.reload();
  expect(accountsConfig().codex?.active).toBe('c');
  store.close();
});

it('lists no live accounts on an empty store', () => {
  const store = openStore(':memory:');
  expect(liveAccountNames(store, 'claude')).toEqual([]);
  store.close();
});


it('maps each core to its default account folder', () => {
  expect(DEFAULT_DIRS.claude('/h')).toBe('/h/.claude');
  expect(DEFAULT_DIRS.codex('/h')).toBe('/h/.codex');
  expect(DEFAULT_DIRS.antigravity('/h')).toBe('/h/.gemini/antigravity-cli');
  expect(DEFAULT_DIRS.opencode('/h')).toBe('/h/.local/share/opencode');
  expect(DEFAULT_DIRS.opencode2('/h')).toBe('/h/.local/share/opencode');
});

it('resolves an absolute executable and rejects a missing or non-executable file', async () => {
  const exe = join(root, 'tool');
  await writeFile(exe, '#!/bin/sh\n');
  await chmod(exe, 0o755);
  const plain = join(root, 'plain');
  await writeFile(plain, 'x');
  await chmod(plain, 0o644);
  expect(await binaryResolves(exe)).toBe(true);
  expect(await binaryResolves(plain)).toBe(false);
  expect(await binaryResolves(join(root, 'nope'))).toBe(false);
  expect(await binaryResolves('definitely-not-a-binary-xyz')).toBe(false);
});

it('finds a PATH binary', async () => {
  const exe = join(root, 'pathtool');
  await writeFile(exe, '#!/bin/sh\n');
  await chmod(exe, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${root}:/nonexistent`;
  try {
    expect(await binaryResolves('pathtool')).toBe(true);
  } finally {
    process.env.PATH = old;
  }
});

it('reads an alias through the shell and refuses a bad alias name', async () => {
  const sh = join(root, 'fakeshell');
  await writeFile(sh, "#!/bin/sh\necho \"$1 $2 $KARST_PROBE\"\n");
  await chmod(sh, 0o755);
  const old = process.env.SHELL;
  process.env.SHELL = sh;
  try {
    process.env.KARST_PROBE = 'seen';
    expect((await lookupAlias('claude-work')).trim()).toBe('-ic alias claude-work seen');
    await expect(lookupAlias('a; rm -rf /')).rejects.toThrow(/not a valid alias name/);
  } finally {
    process.env.SHELL = old;
    delete process.env.KARST_PROBE;
  }
});

it('rejects when the shell fails with no output and resolves when it prints before failing', async () => {
  const failing = join(root, 'failshell');
  await writeFile(failing, '#!/bin/sh\nexit 1\n');
  await chmod(failing, 0o755);
  const printing = join(root, 'printshell');
  await writeFile(printing, "#!/bin/sh\necho \"x='y'\"\nexit 1\n");
  await chmod(printing, 0o755);
  const old = process.env.SHELL;
  try {
    process.env.SHELL = failing;
    await expect(lookupAlias('nope')).rejects.toThrow("could not read the alias 'nope' from the shell");
    process.env.SHELL = printing;
    expect((await lookupAlias('x')).trim()).toBe("x='y'");
  } finally {
    process.env.SHELL = old;
  }
});

it('skips an empty PATH segment instead of searching the working directory', async () => {
  const name = `karst-reltool-${process.pid}`;
  const exe = join(process.cwd(), name);
  await writeFile(exe, '#!/bin/sh\n');
  await chmod(exe, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    expect(await binaryResolves(name)).toBe(false);
  } finally {
    process.env.PATH = oldPath;
    await rm(exe, { force: true });
  }
});

it('wires the managed root, debug, status and the recorded-account lookup', async () => {
  const store = openStore(':memory:');
  const debug: string[] = [];
  const w = await wireAccounts({ globalStorageRoot: root, store, debug: (m) => debug.push(m) });
  await w.ops.createAccount('claude', 'm', { source: 'managed' });
  expect(accountsConfig().claude?.list.m?.dir).toBe(join(root, 'accounts', 'claude', 'm'));
  expect(debug.some((m) => m.includes('claude/m'))).toBe(true);
  expect(await w.ops.accountStatus('claude', 'm')).toBe('unknown');
  // A publishing save keeps the file and the registry equal.
  const second = await wireAccounts({ globalStorageRoot: root, store });
  expect(accountsConfig().claude?.list.m).toBeDefined();
  expect((await second.ops.listAccounts('claude')).map((r) => r.name)).toEqual(['default', 'm']);
  store.close();
});

it('does not leak a failed load into the registry', async () => {
  const store = openStore(':memory:');
  const bad = { load: async () => { throw new Error('boom'); }, save: async () => undefined };
  await expect(wireAccounts({ globalStorageRoot: root, store, accountStore: bad })).rejects.toThrow('boom');
  store.close();
});

it('re-publishes the config when another window changes accounts.json, and stops after dispose', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store });
  const other = fileAccountStore(root);
  const next = { codex: { active: 'c', list: { c: { kind: 'subscription' as const, source: 'folder' as const, dir: '/h/c' } } } };
  await other.save(next);
  await vi.waitFor(() => expect(accountsConfig().codex?.active).toBe('c'), { timeout: ACCOUNTS_WATCH_MS * 5 });
  w.dispose();
  resetAccounts();
  await other.save({ ...next, codex: { ...next.codex, active: 'default' } });
  await new Promise((r) => setTimeout(r, ACCOUNTS_WATCH_MS * 2.5));
  expect(accountsConfig()).toEqual({});
  store.close();
});

it('does not watch a file when the account store is injected', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store, accountStore: { load: async () => ({}), save: async () => {} } });
  expect(() => w.dispose()).not.toThrow();
  store.close();
});
