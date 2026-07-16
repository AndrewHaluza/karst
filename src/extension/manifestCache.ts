import type { Manifest } from '../manifest/types.js';

/**
 * Injected seams so the cache stays `vscode`-free (and therefore testable under
 * vitest): `pathOf` resolves the workspace manifest path (throws with no folder),
 * `exists`/`load` are the disk reads.
 */
export interface ManifestCacheDeps {
  pathOf: () => string;
  exists: (path: string) => boolean;
  load: (path: string) => Manifest;
}

export interface ManifestCache {
  /** The live manifest, loading it on first use; undefined when unavailable. */
  get: () => Manifest | undefined;
  /** Adopt a manifest a command already resolved (skips the disk read). */
  set: (manifest: Manifest, path: string) => void;
  /** Drop the cached copy so the next `get` re-reads from disk. */
  reload: () => void;
  /**
   * Where the manifest lives, resolved from the workspace even when it could not
   * be loaded (absent/invalid); undefined only when there is no folder at all.
   */
  path: () => string | undefined;
}

/**
 * Lazily-loaded holder for the workspace manifest.
 *
 * Consumers used to read a `currentManifest` variable that only a create/edit
 * command ever assigned, so surfaces reachable without those commands (the
 * dashboard, opened straight from the sidebar on a fresh window) silently saw
 * no manifest: no ticketing provider → no board link, no label template, no
 * worktree path context. Loading on demand makes the manifest a function of
 * disk rather than of which command the user happened to run first.
 *
 * Resolution never prompts and never throws — an absent/invalid manifest yields
 * undefined and is retried on the next `get`, so callers keep their documented
 * "absent → degrade quietly" behavior while a fixed file recovers on its own.
 */
export function makeManifestCache(deps: ManifestCacheDeps): ManifestCache {
  let manifest: Manifest | undefined;
  let manifestPath: string | undefined;

  return {
    get() {
      if (manifest) return manifest;
      try {
        const path = deps.pathOf();
        if (!deps.exists(path)) return undefined;
        manifest = deps.load(path);
        manifestPath = path;
      } catch {
        return undefined; // no folder, or an invalid manifest — retried next call
      }
      return manifest;
    },
    set(next, path) {
      manifest = next;
      manifestPath = path;
    },
    reload() {
      manifest = undefined;
    },
    path() {
      if (manifestPath) return manifestPath;
      try {
        return deps.pathOf();
      } catch {
        return undefined; // no workspace folder
      }
    },
  };
}
