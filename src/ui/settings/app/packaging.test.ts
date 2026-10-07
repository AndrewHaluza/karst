/**
 * Packaging guard for the staged-VSIX pipeline.
 *
 * `install-local.sh` and `package-remote.sh` no longer run `vsce` against the
 * repo root, where it walked ~750k files (`.karst/` worktrees, `.stryker-tmp/`)
 * before `.vscodeignore` filtered them. They package from a throwaway stage
 * built by `scripts/stage-vsix.mjs`, whose contents ARE `scripts/stage-copy-list.json`.
 * This test pins that list against the real runtime dependency closure, so a
 * packaged VSIX can never ship `better-sqlite3` while pruning `bindings` (or
 * `js-yaml`) — a failure that only surfaces as `Cannot find module` on the first
 * `openStore` in a user's IDE, because F5 and `npm test` both read the repo's
 * node_modules and never see the package.
 *
 * The keep-list is NOT a hardcoded pair. Every package the bundles leave
 * `external` (see `scripts/build-extension.mjs`) is resolved by walking the
 * `require()` calls its shipped entry actually makes, transitively. Install-time
 * dependencies (`prebuild-install`'s tree, js-yaml's CLI-only `argparse`) are
 * deliberately not required at runtime, so `stage-vsix.mjs` stubs them out for
 * vsce's npm-list check and the stage `.vscodeignore` keeps them out of the VSIX.
 *
 * `.vscodeignore` is left in place for now (a follow-up cleans it up); it no
 * longer decides what ships, so nothing here replays it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

function findNodeModulesDir(start: string): string {
  let curr = start;
  while (curr !== dirname(curr)) {
    const candidate = join(curr, 'node_modules');
    if (
      existsSync(candidate) &&
      existsSync(join(candidate, 'better-sqlite3')) &&
      existsSync(join(candidate, 'js-yaml'))
    ) {
      return candidate;
    }
    curr = dirname(curr);
  }
  return join(start, 'node_modules');
}
const NODE_MODULES = findNodeModulesDir(ROOT);

type StageCopyList = {
  required: string[];
  optional: string[];
  nodeModulesPackages: string[];
};
const COPY_LIST = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'stage-copy-list.json'), 'utf8'),
) as StageCopyList;
const STAGE_ENTRIES = [...COPY_LIST.required, ...COPY_LIST.optional];

/** Packages `scripts/build-extension.mjs` leaves unbundled, and so that must ship. */
const EXTERNAL_PACKAGES = ['better-sqlite3', 'js-yaml'] as const;

type PackageJson = {
  main?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
};

function readPackageJson(name: string): PackageJson | null {
  const manifestPath = join(NODE_MODULES, name, 'package.json');
  return existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageJson)
    : null;
}

/**
 * Bare (non-relative, non-builtin) specifiers a shipped JS file requires.
 * Scoped names collapse to the package root: `@scope/name/sub` -> `@scope/name`.
 */
function requiredPackages(source: string): Set<string> {
  const found = new Set<string>();
  const requireCall = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(requireCall)) {
    const specifier = match[1]!;
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    if (specifier.startsWith('node:')) continue;
    const parts = specifier.split('/');
    found.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
  }
  return found;
}

/**
 * Transitive closure of packages reached by following real `require()` calls out
 * of each external package's entry point. Walks in-file requires too, so a
 * lazily-required sibling (`better-sqlite3/lib/database.js` -> `bindings`) is
 * found without trusting the declared dependency list.
 */
function runtimeClosure(roots: readonly string[]): Set<string> {
  const closure = new Set<string>();
  const visitedFiles = new Set<string>();
  const queue: string[] = [...roots];

  while (queue.length > 0) {
    const pkgName = queue.pop()!;
    const packageDir = join(NODE_MODULES, pkgName);
    const manifest = readPackageJson(pkgName);
    if (manifest === null) continue;
    closure.add(pkgName);

    // `main` is the entry the extension host loads, but a lazily-required
    // sibling can pull in a package the entry never names — better-sqlite3's
    // `lib/database.js` requires `bindings` behind a `DEFAULT_ADDON` check.
    // Scan those too so the closure does not depend on which file is `main`.
    const files = new Set<string>();
    for (const relative of ['lib', 'dist', 'build']) {
      const dir = join(packageDir, relative);
      if (!existsSync(dir)) continue;
      for (const candidate of ['index.js', 'database.js', 'bindings.js', 'main.js']) {
        const file = join(dir, candidate);
        if (existsSync(file)) files.add(file);
      }
    }
    const entry = join(packageDir, manifest.main ?? 'index.js');
    if (existsSync(entry)) files.add(entry);

    for (const file of files) {
      if (visitedFiles.has(file)) continue;
      visitedFiles.add(file);
      // requiredPackages already drops relative and `node:` specifiers, so
      // every name here is a bare specifier that leaves this package.
      for (const required of requiredPackages(readFileSync(file, 'utf8'))) {
        if (readPackageJson(required) === null) continue;
        if (closure.has(required) && visitedFiles.has(join(NODE_MODULES, required, 'index.js'))) {
          continue;
        }
        queue.push(required);
      }
    }
  }

  return closure;
}

describe('stage-vsix copy list packaging', () => {
  it('derives a non-empty runtime closure from real require() calls', () => {
    const closure = runtimeClosure(EXTERNAL_PACKAGES);
    // Non-vacuity: a walker that silently resolved nothing would pass every
    // other assertion here by proving nothing.
    expect(closure.size).toBeGreaterThanOrEqual(EXTERNAL_PACKAGES.length);
    for (const name of EXTERNAL_PACKAGES) expect(closure.has(name)).toBe(true);
  });

  it('keeps every package in the runtime dependency closure', () => {
    for (const name of runtimeClosure(EXTERNAL_PACKAGES)) {
      expect(COPY_LIST.nodeModulesPackages, `${name} would be pruned from the VSIX`).toContain(
        name,
      );
    }
  });

  it('copies every runtime package whole (bindings included, not just better-sqlite3)', () => {
    // The transitive closure above is what proves the list is complete; this
    // asserts the shape the helper relies on — one top-level entry per package.
    for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'js-yaml']) {
      expect(COPY_LIST.nodeModulesPackages).toContain(name);
      expect(STAGE_ENTRIES).toContain(`node_modules/${name}`);
    }
  });

  it('declares only packages the stage actually ships as production dependencies', () => {
    // vsce runs `npm list --production` inside the STAGE, whose node_modules is
    // exactly COPY_LIST.nodeModulesPackages. A production dependency the stage
    // does not carry fails it with `npm error missing: <pkg>, required by
    // karst` — which is how a bundled-at-build-time package (the MCP SDK,
    // inlined into dist/cli/main.js by esbuild) breaks every `install-local.sh`
    // run. Build-time packages belong in devDependencies, exactly where this
    // repo already keeps react for the same reason (architecture.test.ts).
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(
        COPY_LIST.nodeModulesPackages,
        `${name} is a production dependency but the stage does not ship it`,
      ).toContain(name);
    }
  });

  it('includes the package that carries the native addon the bindings loader opens', () => {
    // better-sqlite3 ships prebuilds under bin/<platform>-<abi>/ and the helper
    // copies one into build/Release. `bindings` opens exactly that path, so the
    // whole package must be staged (the addon is placed into it after copy).
    expect(COPY_LIST.required).toContain('node_modules/better-sqlite3');
  });

  it('excludes React, testing-library and eslint runtime packages from the stage', () => {
    for (const name of COPY_LIST.nodeModulesPackages) {
      expect(/react|testing-library|eslint/i.test(name), `${name} would ship`).toBe(false);
    }
  });

  it('only names required entries that exist in the repo', () => {
    for (const entry of COPY_LIST.required) {
      // A node_modules entry may resolve OUTSIDE this checkout: a git worktree
      // (`.karst/worktrees/<name>/`) has no node_modules of its own and inherits
      // the main checkout's install. Resolve those through the same walked-up
      // directory the closure walk above uses, not raw ROOT — otherwise this
      // guard fails on every worktree and proves nothing.
      const resolved = entry.startsWith('node_modules/')
        ? join(NODE_MODULES, entry.slice('node_modules/'.length))
        : join(ROOT, entry);
      expect(existsSync(resolved), `required stage entry is missing: ${entry}`).toBe(true);
    }
  });
});
