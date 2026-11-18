import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSETS_ROOT } from './runtimeAssetsRoot.js';

/**
 * The extension ships as one esbuild bundle, so `import.meta.url` in every module
 * collapses to `dist/extension.js`. A module that builds an asset path from its own
 * `import.meta.url` gets a different answer bundled than unbundled (T1202: the harness
 * runner path named `dist/harnessRunner.mjs`, which does not exist). Use
 * `join(RUNTIME_ASSETS_ROOT, '<src-relative path>')` instead.
 */
const ALLOWED = new Set<string>([
  // The one anchor itself.
  'runtimeAssetsRoot.ts',
]);

const SRC = RUNTIME_ASSETS_ROOT;
const PATH_CALL = /(?:new\s+URL|fileURLToPath)\s*\([^)]*import\.meta\.url/s;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('import.meta.url path guard', () => {
  it('no module outside the allowlist builds a path from its own import.meta.url', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => PATH_CALL.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))));
    expect(
      offenders,
      'Do not build a path from import.meta.url: it collapses to dist/extension.js in the bundle. Use join(RUNTIME_ASSETS_ROOT, "<src-relative path>") from src/runtimeAssetsRoot.ts.',
    ).toEqual([]);
  });
});
