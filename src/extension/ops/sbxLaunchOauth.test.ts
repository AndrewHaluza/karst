import { describe, expect, it, vi } from 'vitest';
import { oauthPolicyArgs } from '../../agent/sbx/sbxOauthGuest.js';
import { createLaunchOauthInput, createSbxGrantReleaser } from './sbxLaunchOauth.js';

describe('createSbxGrantReleaser', () => {
  it('revokes the key, then removes the policy rule of the proxy port', async () => {
    const order: string[] = [];
    const release = createSbxGrantReleaser({
      grants: { release: vi.fn(async () => { order.push('revoke'); return { port: 8787 }; }) },
      run: vi.fn(async (args: string[]) => { order.push(args.slice(0, 2).join(' ')); return { code: 0, stderr: '' }; }),
    });
    await release('sb');
    expect(order).toEqual(['revoke', 'policy rm']);
  });

  it('removes no rule when the sandbox held no grant', async () => {
    const run = vi.fn();
    await createSbxGrantReleaser({ grants: { release: async () => ({}) }, run })('sb');
    expect(run).not.toHaveBeenCalled();
  });

  it('logs a refused rule removal and does not throw (the sandbox may be gone)', async () => {
    const debug = vi.fn();
    const release = createSbxGrantReleaser({ grants: { release: async () => ({ port: 1 }) }, run: async () => ({ code: 1, stderr: 'no such sandbox' }), debug });
    await expect(release('sb')).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('policy rm'));
  });
  it('runs the exact policy rm of the sandbox and port, and logs nothing on success', async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: 'noise' }));
    const debug = vi.fn();
    await createSbxGrantReleaser({ grants: { release: async () => ({ port: 8787 }) }, run, debug })('sb');
    expect(run).toHaveBeenCalledWith(oauthPolicyArgs('rm', 'sb', 8787));
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs the exit code and a trimmed, bounded stderr of a refused rule removal', async () => {
    const debug = vi.fn();
    const stderr = `  ${'x'.repeat(300)}  `;
    await createSbxGrantReleaser({ grants: { release: async () => ({ port: 1 }) }, run: async () => ({ code: 3, stderr }), debug })('sb');
    expect(debug).toHaveBeenCalledWith(`[oauth-proxy] sbx policy rm for sb exited 3: ${'x'.repeat(200)}`);
  });

  it('works with no debug callback', async () => {
    await expect(createSbxGrantReleaser({ grants: { release: async () => ({ port: 1 }) }, run: async () => ({ code: 1, stderr: '' }) })('sb')).resolves.toBeUndefined();
  });
});

describe('launch oauth input errors', () => {
  it('logs, without the error text, when the account list fails, and still returns no token account', async () => {
    const debug: string[] = [];
    const input = createLaunchOauthInput({
      grants: {} as never, secrets: {} as never,
      listAccounts: async () => { throw new Error('sk-ant-oat01-secret'); },
      debug: (m) => debug.push(m),
    });
    const out = await input();
    expect([...out.tokenAccounts]).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug.join()).not.toContain('secret');
  });
});

describe('grant releaser errors', () => {
  it('logs, without the error text, and does not throw when the release fails', async () => {
    const debug: string[] = [];
    const run = vi.fn();
    const release = createSbxGrantReleaser({ grants: { release: async () => { throw new Error('sk-ant-secret'); } }, run, debug: (m) => debug.push(m) });
    await expect(release('sb')).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(debug).toHaveLength(1);
    expect(debug.join()).not.toContain('secret');
  });
});
