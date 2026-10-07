import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from './runtimeAssetsRoot.js';

/**
 * The build stamp `scripts/stage-vsix.mjs` writes to `dist/build-info.json`
 * before an installer packages the VSIX. It is absent in a plain `npm run
 * build` (dev/F5) and in tests, so every reader must treat it as optional.
 */
export type BuildInfo = {
  /** `git rev-parse --short=8 HEAD` at packaging time. */
  commit8: string;
  /** Whether the tree had uncommitted changes at packaging time. */
  dirty: boolean;
  /** ISO timestamp of the staged build. */
  builtAt: string;
};

/** Read and validate `dist/build-info.json`, or `undefined` when it is absent/malformed. */
export function readBuildInfo(root: string = RUNTIME_ASSETS_ROOT): BuildInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    if (typeof raw.commit8 !== 'string' || typeof raw.builtAt !== 'string') return undefined;
    return { commit8: raw.commit8, dirty: raw.dirty === true, builtAt: raw.builtAt };
  } catch {
    return undefined;
  }
}

/** A one-line, loggable description of a packaged build (or of a dev build). */
export function describeBuildInfo(info: BuildInfo | undefined): string {
  if (!info) return 'build: dev (no build-info.json)';
  return `build: ${info.commit8}${info.dirty ? '-dirty' : ''} built ${info.builtAt}`;
}
