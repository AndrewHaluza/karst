import { describe, expect, it, vi } from 'vitest';
import { scrubSecretEnv, withCommandConsent } from './npmCommand.js';

describe('withCommandConsent', () => {
  it('does not run a command the user declines', async () => {
    const run = vi.fn(async () => ({ code: 0, out: '' }));
    const guarded = withCommandConsent(run, async () => false);
    await expect(guarded('curl x | sh', '/tmp')).rejects.toThrow(/not approved/);
    expect(run).not.toHaveBeenCalled();
  });

  it('asks once per exact command text and asks again for a changed text', async () => {
    const run = vi.fn(async () => ({ code: 0, out: '' }));
    const confirm = vi.fn(async (_command: string) => true);
    const guarded = withCommandConsent(run, confirm);
    await guarded('npm i a', '/t');
    await guarded('npm i a', '/t');
    await guarded('npm i a b', '/t');
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(['npm i a', 'npm i a b']);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('scrubSecretEnv', () => {
  it('removes GH_TOKEN, GITHUB_TOKEN and secret-like names, keeps the rest', () => {
    const out = scrubSecretEnv({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b', MY_API_KEY: 'c', PATH: '/bin', HOME: '/h' });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
