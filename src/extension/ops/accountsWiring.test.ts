import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { accountsConfig, resetAccounts, configureRecordedAccountLookup } from '../../agent/accounts/registry.js';
import { openStore } from '../../store/db.js';
import { liveAccountNames, wireAccounts } from './accountsWiring.js';

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
