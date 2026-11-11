import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fileAccountStore, memoryAccountStore } from '../../agent/accounts/accountStore.js';
import { accountForLaunch, accountsConfig, recordHeadlessSession, resetSessionLedger, trackHeadlessRun, resetAccounts, configureRecordedAccountLookup } from '../../agent/accounts/registry.js';
import { configureOpencode2, resetOpencode2Config } from '../../agent/opencode2Binary.js';
import { loadSessionLedger } from '../../agent/accounts/sessionLedgerStore.js';
import { openStore } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { confirmSessionLaunchIntent, recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { ACCOUNTS_WATCH_MS, binaryResolves, DEFAULT_DIRS, liveAccountNames, lookupAlias, mergeLedgerFile, wireAccounts } from './accountsWiring.js';

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

it('wires the recorded account of a session from the launch intents', async () => {
  const store = openStore(':memory:');
  const ticketId = createTicketFlow(store, { key: 'T-2', title: 't' }).id;
  transition(store, ticketId, 'scope', { kind: 'passed' });
  recordSessionLaunchIntent(store, {
    ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', account: 'work',
    reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
  });
  confirmSessionLaunchIntent(store, 'l1', { ticketId, provider: 'claude', providerSessionId: 'sess-1', at: '2026-08-01T10:01:00.000Z' });
  const w = await wireAccounts({ globalStorageRoot: root, store });
  expect(accountForLaunch('claude', 'sess-1')).toBe('work');
  w.dispose();
  store.close();
});

it('blocks a delete while a headless run is live, and persists the headless ledger', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store });
  try {
    await w.ops.createAccount('claude', 'h', { source: 'folder', dir: '/h/h' });
    const end = trackHeadlessRun('claude', 'h');
    await expect(w.ops.deleteAccount('claude', 'h')).rejects.toThrow(/live session/);
    end();
    await expect(w.ops.deleteAccount('claude', 'h')).resolves.toBeUndefined();
    recordHeadlessSession('claude', 'hs-1', 'work');
    await vi.waitFor(async () => expect(await loadSessionLedger(root)).toEqual({ 'claude:hs-1': 'work' }));
    resetSessionLedger();
    expect(accountForLaunch('claude', 'hs-1')).toBeUndefined();
    await wireAccounts({ globalStorageRoot: root, store, accountStore: fileAccountStore(root) });
    expect(accountForLaunch('claude', 'hs-1')).toBe('work');
  } finally {
    w.dispose();
    resetSessionLedger();
    store.close();
  }
});

it('starts with an empty ledger when the ledger file is not readable', async () => {
  const debug = vi.fn();
  await writeFile(join(root, 'session-accounts.json'), '{not json');
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store, debug });
  expect(debug).toHaveBeenCalledWith(expect.stringContaining('session ledger not loaded'));
  w.dispose();
  resetSessionLedger();
  store.close();
});

it('works without a debug hook when the ledger file can neither be read nor written', async () => {
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'x');
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: blocker, store, accountStore: memoryAccountStore() });
  recordHeadlessSession('claude', 'nd-1', 'work');
  await new Promise((r) => setTimeout(r, 50));
  expect(accountForLaunch('claude', 'nd-1')).toBe('work');
  w.dispose();
  resetSessionLedger();
  store.close();
});

it('reports a ledger entry that cannot be saved', async () => {
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'x');
  const debug = vi.fn();
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: blocker, store, accountStore: memoryAccountStore(), debug });
  recordHeadlessSession('claude', 'sv-1', 'work');
  await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.stringContaining('[accounts] session ledger not saved: ')));
  w.dispose();
  resetSessionLedger();
  store.close();
});

it('keeps the entries of another window and merges them into this window', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store });
  try {
    await writeFile(join(root, 'session-accounts.json'), JSON.stringify({ 'claude:other': 'w2' }));
    recordHeadlessSession('claude', 'mine', 'w1');
    await vi.waitFor(async () => expect(await loadSessionLedger(root)).toEqual({ 'claude:other': 'w2', 'claude:mine': 'w1' }));
    await vi.waitFor(() => expect(accountForLaunch('claude', 'other')).toBe('w2'), { timeout: ACCOUNTS_WATCH_MS * 5 });
  } finally {
    w.dispose();
    resetSessionLedger();
    store.close();
  }
});

it('merges a ledger file directly, and reports an unreadable one', async () => {
  await writeFile(join(root, 'session-accounts.json'), JSON.stringify({ 'claude:m1': 'w2' }));
  await mergeLedgerFile(root);
  expect(accountForLaunch('claude', 'm1')).toBe('w2');
  await writeFile(join(root, 'session-accounts.json'), '{bad');
  const msgs: string[] = [];
  await mergeLedgerFile(root, (m) => msgs.push(m));
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatch(/^\[accounts\] session ledger not merged: /);
  await expect(mergeLedgerFile(root)).resolves.toBeUndefined();
  resetSessionLedger();
});

it('stops merging the ledger of other windows after dispose', async () => {
  const store = openStore(':memory:');
  const w = await wireAccounts({ globalStorageRoot: root, store });
  w.dispose();
  resetSessionLedger();
  await writeFile(join(root, 'session-accounts.json'), JSON.stringify({ 'claude:late': 'w2' }));
  await new Promise((r) => setTimeout(r, ACCOUNTS_WATCH_MS * 2.5));
  expect(accountForLaunch('claude', 'late')).toBeUndefined();
  store.close();
});

it('lists no live accounts on an empty store', () => {
  const store = openStore(':memory:');
  expect(liveAccountNames(store, 'claude')).toEqual([]);
  store.close();
});


it('counts a fix launch with an open recovery round as live, and not a closed one', () => {
  const store = openStore(':memory:');
  const ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
  const round = openRecoveryRound(store, {
    ticketId, sourceStage: 'uat', sourceProcessId: 'gates', sourceStageRunId: null, sourceProcessRunId: null,
    triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3, startedAt: '2026-08-01T10:00:00.000Z',
  });
  recordSessionLaunchIntent(store, {
    ticketId, launchId: 'f1', purpose: 'fix', provider: 'claude', account: 'work', recoveryRoundId: round.id,
    reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:01.000Z',
  });
  expect(liveAccountNames(store, 'claude')).toEqual(['work']);
  expect(liveAccountNames(store, 'codex')).toEqual([]);
  store.db.prepare("UPDATE recovery_rounds SET status = 'passed' WHERE id = ?").run(round.id);
  expect(liveAccountNames(store, 'claude')).toEqual([]);
  store.close();
});

it('maps each core to its default account folder', () => {
  expect(DEFAULT_DIRS.claude('/h')).toBe('/h/.claude');
  expect(DEFAULT_DIRS.codex('/h')).toBe('/h/.codex');
  expect(DEFAULT_DIRS.antigravity('/h')).toBe('/h/.gemini/antigravity-cli');
  expect(DEFAULT_DIRS.opencode('/h')).toBe('/h/.local/share/opencode');
  expect(DEFAULT_DIRS.opencode2('/h')).toBe('/h/.local/share/opencode');
  configureOpencode2({ home: '/karst/oc2' });
  try {
    expect(DEFAULT_DIRS.opencode2('/h')).toBe('/karst/oc2');
  } finally {
    resetOpencode2Config();
  }
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
  expect(await w.ops.accountStatus('claude', 'm')).toBe('not-signed-in');
  await writeFile(join(root, 'accounts', 'claude', 'm', '.credentials.json'), '{}');
  expect(await w.ops.accountStatus('claude', 'm')).toBe('signed-in');
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

it('signals a change after a write and a reload, but not after the first load (T1076)', async () => {
  const store = openStore(':memory:');
  const onChange = vi.fn();
  const w = await wireAccounts({ globalStorageRoot: root, store, accountStore: memoryAccountStore(), onChange });
  try {
    expect(onChange).not.toHaveBeenCalled();
    await w.ops.createAccount('claude', 'w', { source: 'folder', dir: '/h/w' });
    const afterCreate = onChange.mock.calls.length;
    expect(afterCreate).toBeGreaterThan(0);
    await w.ops.setActive('claude', 'w');
    expect(onChange.mock.calls.length).toBeGreaterThan(afterCreate);
    const afterSwitch = onChange.mock.calls.length;
    await w.reload();
    expect(onChange.mock.calls.length).toBe(afterSwitch + 1);
  } finally {
    w.dispose();
    store.close();
  }
});
