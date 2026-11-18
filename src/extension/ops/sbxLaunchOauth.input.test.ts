import { describe, expect, it } from 'vitest';
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { SecretStore } from '../secretStore.js';
import { setSbxToken } from '../sbxTokenStore.js';
import { createLaunchOauthInput } from './sbxLaunchOauth.js';

const rows: AccountRow[] = [
  { name: 'default', active: true },
  { name: 'work', active: false, account: { kind: 'subscription', source: 'managed', dir: '/m' } },
  { name: 'home', active: false, account: { kind: 'subscription', source: 'folder', dir: '/h' } },
];

describe('createLaunchOauthInput', () => {
  it('names the accounts that hold a token, and passes the grants', async () => {
    const map = new Map<string, string>();
    const secrets: SecretStore = { get: async (k) => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
    await setSbxToken(secrets, 'claude', 'work', 'sk-ant-oat01-abcdefghijkl');
    const grants = { issue: async () => ({ ok: false as const, reason: 'x' }), release: async () => ({}) };
    const input = await createLaunchOauthInput({ grants, secrets, listAccounts: async () => rows })();
    expect([...input.tokenAccounts]).toEqual(['work']);
    expect(input.grants).toBe(grants);
  });

  it('gives no token account when the account list fails', async () => {
    const secrets: SecretStore = { get: async () => undefined, store: async () => {}, delete: async () => {} };
    const grants = { issue: async () => ({ ok: false as const, reason: 'x' }), release: async () => ({}) };
    const input = await createLaunchOauthInput({ grants, secrets, listAccounts: async () => { throw new Error('x'); } })();
    expect(input.tokenAccounts.size).toBe(0);
  });
});
