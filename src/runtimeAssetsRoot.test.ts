import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ASSETS_ROOT } from './runtimeAssetsRoot.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The bug this file exists to prevent, twice shipped:
 *
 * a module reads a runtime asset by doing path arithmetic on its OWN
 * `import.meta.url`. The extension ships as ONE esbuild bundle, so inside
 * `dist/extension.js` every module's `import.meta.url` collapses to `dist/` —
 * the same expression means two different directories depending on whether the
 * code was bundled. `model/agentIdentity.ts` looked for `dist/icons/agent/`
 * (every agent-core icon silently degraded to a label-only badge) and
 * `extension/manifestResolve.ts` walked `..` clean out of the compiled output.
 *
 * `RUNTIME_ASSETS_ROOT` is the ONE anchor that is correct in both worlds. This
 * test holds the rule for the whole tree, so a new asset read cannot
 * reintroduce the class.
 */

function tsFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('RUNTIME_ASSETS_ROOT', () => {
  it('is this file’s own directory — the src root, mirrored by dist/', () => {
    expect(RUNTIME_ASSETS_ROOT).toBe(SRC);
  });

  it('is the only module deriving a directory from its own import.meta.url', () => {
    const offenders = tsFiles(SRC)
      .filter((file) => relative(SRC, file) !== 'runtimeAssetsRoot.ts')
      .filter((file) => /dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/.test(
        readFileSync(file, 'utf8'),
      ))
      .map((file) => relative(SRC, file));

    expect(offenders, 'read runtime assets from RUNTIME_ASSETS_ROOT instead').toEqual([]);
  });
});
