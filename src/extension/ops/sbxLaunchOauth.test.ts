import { describe, expect, it, vi } from 'vitest';
import { createSbxGrantReleaser } from './sbxLaunchOauth.js';

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
});
