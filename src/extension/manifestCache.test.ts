import { describe, it, expect, vi } from 'vitest';
import { makeManifestCache } from './manifestCache.js';
import type { Manifest } from '../manifest/types.js';

const manifest = (provider: 'clickup' | 'manual' = 'clickup'): Manifest =>
  ({ services: {}, ticketing: { provider } }) as unknown as Manifest;

describe('makeManifestCache', () => {
  it('loads the manifest on first get — no command side effect required', () => {
    const load = vi.fn(() => manifest());
    const cache = makeManifestCache({ pathOf: () => '/ws/karst.yml', exists: () => true, load });

    expect(cache.get()?.ticketing?.provider).toBe('clickup');
    expect(load).toHaveBeenCalledWith('/ws/karst.yml');
  });

  it('caches after a successful load (one read per manifest)', () => {
    const load = vi.fn(() => manifest());
    const cache = makeManifestCache({ pathOf: () => '/ws/karst.yml', exists: () => true, load });

    cache.get();
    cache.get();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the manifest file is absent — never prompts/throws', () => {
    const cache = makeManifestCache({
      pathOf: () => '/ws/karst.yml',
      exists: () => false,
      load: () => manifest(),
    });

    expect(cache.get()).toBeUndefined();
  });

  it('returns undefined when there is no workspace folder (pathOf throws)', () => {
    const cache = makeManifestCache({
      pathOf: () => {
        throw new Error('no workspace folder');
      },
      exists: () => true,
      load: () => manifest(),
    });

    expect(cache.get()).toBeUndefined();
  });

  it('returns undefined on an invalid manifest, and retries on the next get', () => {
    const load = vi
      .fn<(p: string) => Manifest>()
      .mockImplementationOnce(() => {
        throw new Error('bad yaml');
      })
      .mockImplementationOnce(() => manifest());
    const cache = makeManifestCache({ pathOf: () => '/ws/karst.yml', exists: () => true, load });

    expect(cache.get()).toBeUndefined();
    expect(cache.get()?.ticketing?.provider).toBe('clickup');
  });

  it('set() adopts a caller-resolved manifest without re-reading disk', () => {
    const load = vi.fn(() => manifest('clickup'));
    const cache = makeManifestCache({ pathOf: () => '/ws/karst.yml', exists: () => true, load });

    cache.set(manifest('manual'), '/ws/karst.yml');

    expect(cache.get()?.ticketing?.provider).toBe('manual');
    expect(load).not.toHaveBeenCalled();
    expect(cache.path()).toBe('/ws/karst.yml');
  });

  it('path() resolves from the workspace even before anything is cached', () => {
    const cache = makeManifestCache({
      pathOf: () => '/ws/karst.yml',
      exists: () => false, // an invalid/absent manifest must not hide the path
      load: () => manifest(),
    });

    expect(cache.get()).toBeUndefined();
    expect(cache.path()).toBe('/ws/karst.yml');
  });

  it('path() returns the adopted path, not the workspace-resolved one', () => {
    const pathOf = vi.fn().mockReturnValue('/ws/.karst/karst.yml');
    const cache = makeManifestCache({
      pathOf,
      exists: vi.fn().mockReturnValue(true),
      load: vi.fn().mockReturnValue({} as never),
    });
    cache.set({} as never, '/adopted/.karst/karst.yml');
    expect(cache.path()).toBe('/adopted/.karst/karst.yml');
  });

  it('path() is undefined when there is no workspace folder', () => {
    const cache = makeManifestCache({
      pathOf: () => {
        throw new Error('no workspace folder');
      },
      exists: () => true,
      load: () => manifest(),
    });

    expect(cache.path()).toBeUndefined();
  });

  it('reload() re-reads from disk so a save is observed', () => {
    const load = vi
      .fn<(p: string) => Manifest>()
      .mockImplementationOnce(() => manifest('clickup'))
      .mockImplementationOnce(() => manifest('manual'));
    const cache = makeManifestCache({ pathOf: () => '/ws/karst.yml', exists: () => true, load });

    expect(cache.get()?.ticketing?.provider).toBe('clickup');
    cache.reload();

    expect(cache.get()?.ticketing?.provider).toBe('manual');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
