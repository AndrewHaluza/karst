import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Static check on scripts/build-extension.mjs: the CLI is the ONLY other
// runtime entrypoint (docs/arch/cli.md) and must be bundled as a second
// esbuild entry, or shipped VSIXs have no dist/cli/main.js and every agent
// CLI verb fails with MODULE_NOT_FOUND. Kept cheap (text assertions only,
// no build run) so npm run test:unit stays fast.
describe('scripts/build-extension.mjs', () => {
  const scriptPath = path.resolve(
    fileURLToPath(import.meta.url),
    '../../../scripts/build-extension.mjs',
  );
  const source = readFileSync(scriptPath, 'utf8');

  it('declares the CLI entry point bundled to dist/cli/main.js', () => {
    expect(source).toContain('src/cli/main.ts');
    expect(source).toContain('dist/cli/main.js');
  });

  it('sets the shebang banner on the CLI build so it stays directly executable', () => {
    expect(source).toContain('#!/usr/bin/env node');
    expect(source).toContain('banner');
  });
});
