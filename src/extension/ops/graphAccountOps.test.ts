import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountOps } from '../../agent/accounts/accountOps.js';
import { configureAccounts, resetAccounts } from '../../agent/accounts/registry.js';
import { makeGraphAccountSeams } from './graphAccountOps.js';

afterEach(() => resetAccounts());

function ops(over: Partial<AccountOps> = {}): AccountOps {
  return {
    listAccounts: vi.fn(async () => [
      { name: 'default', active: true },
      { name: 'work', active: false, account: { kind: 'subscription', source: 'folder', dir: '/a/work' } },
    ]),
    accountStatus: vi.fn(async () => 'signed-in' as const),
    ...over,
  } as unknown as AccountOps;
}

describe('makeGraphAccountSeams (T1386)', () => {
  it('lists the core accounts without their stored folder data', async () => {
    const seams = makeGraphAccountSeams(ops());
    await expect(seams.accountsOf('claude')).resolves.toEqual([
      { name: 'default', active: true },
      { name: 'work', active: false },
    ]);
  });

  it('offers no accounts when the host has no account operations', async () => {
    const seams = makeGraphAccountSeams(undefined);
    await expect(seams.accountsOf('claude')).resolves.toBeUndefined();
    await expect(seams.accountStatus('claude', 'work')).resolves.toBe('unknown');
  });

  it('treats a provider that is not an account core as having no accounts', async () => {
    const listAccounts = vi.fn();
    const seams = makeGraphAccountSeams(ops({ listAccounts }));
    await expect(seams.accountsOf('bogus')).resolves.toBeUndefined();
    await expect(seams.accountStatus('bogus', 'work')).resolves.toBe('unknown');
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('reads the signed-in probe of one account', async () => {
    const seams = makeGraphAccountSeams(ops());
    await expect(seams.accountStatus('claude', 'work')).resolves.toBe('signed-in');
  });

  it('reads the process-wide accounts config the host published', () => {
    configureAccounts({ claude: { active: 'work', list: {} } });
    expect(makeGraphAccountSeams(ops()).accountsConfig()).toEqual({ claude: { active: 'work', list: {} } });
  });
});
