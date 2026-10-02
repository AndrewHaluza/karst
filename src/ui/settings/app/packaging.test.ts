/**
 * Packaging guard for the React migration (NDL-126 §1).
 *
 * The design calls for a `vsce ls` assertion that no `react*` path ships. `vsce`
 * is not a repo dependency and `npx` is not hermetic (and in this workspace npm
 * redacts the dependency UUIDs `vsce ls` needs), so this test pins the same
 * property statically instead: `.vscodeignore` must keep its one-glob-per-line
 * shape, and replaying those rules over a candidate file list must exclude every
 * React/dev path.
 *
 * The keep-list is NOT a hardcoded pair. Every package `build-extension.mjs`
 * leaves `external` is resolved by walking the `require()` calls its shipped
 * entry actually makes, transitively. That is the runtime closure — a packaged
 * VSIX that keeps `better-sqlite3` but prunes `bindings` fails on the first
 * `openStore` with `Cannot find module 'bindings'`, and only a closure derived
 * from real requires catches that. Install-time-only dependencies
 * (`prebuild-install`'s tree, run from better-sqlite3's `install` script rather
 * than from its runtime code) are deliberately not required at runtime, so they
 * stay pruned and do not bloat the VSIX.
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

const LINES = readFileSync(join(ROOT, '.vscodeignore'), 'utf8').split('\n');
const RULES = LINES.map((line) => line.trim()).filter(
  (line) => line.length > 0 && !line.startsWith('#'),
);

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

function isIgnored(path: string): boolean {
  let ignored = false;
  for (const rule of RULES) {
    const negated = rule.startsWith('!');
    const pattern = negated ? rule.slice(1) : rule;
    if (globToRegExp(pattern).test(path)) ignored = !negated;
  }
  return ignored;
}

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

/** Every path inside a package that a replay can be asked about. */
function samplePaths(name: string): string[] {
  const packageDir = join(NODE_MODULES, name);
  const samples = [`node_modules/${name}/index.js`];
  for (const relative of ['lib/database.js', 'build/Release/better_sqlite3.node']) {
    if (existsSync(join(packageDir, relative))) {
      samples.push(`node_modules/${name}/${relative}`);
    }
  }
  return samples;
}

describe('.vscodeignore packaging', () => {
  it('keeps exactly one glob per line (vsce splits on newlines only)', () => {
    for (const line of RULES) {
      expect(line.split(/\s+/), `"${line}" is not a single glob`).toHaveLength(1);
    }
  });

  it('excludes React, testing-library and eslint from the VSIX', () => {
    for (const path of [
      'node_modules/react/index.js',
      'node_modules/react-dom/index.js',
      'node_modules/@testing-library/react/index.js',
      'node_modules/@testing-library/dom/index.js',
      'node_modules/eslint/bin/eslint.js',
      'node_modules/@types/react/index.d.ts',
    ]) {
      expect(isIgnored(path), `${path} would ship`).toBe(true);
    }
  });

  it('derives a non-empty runtime closure from real require() calls', () => {
    const closure = runtimeClosure(EXTERNAL_PACKAGES);
    // Non-vacuity: a walker that silently resolved nothing would pass every
    // other assertion here by proving nothing.
    expect(closure.size).toBeGreaterThanOrEqual(EXTERNAL_PACKAGES.length);
    for (const name of EXTERNAL_PACKAGES) expect(closure.has(name)).toBe(true);
  });

  it('keeps every package in the runtime dependency closure', () => {
    for (const name of runtimeClosure(EXTERNAL_PACKAGES)) {
      for (const path of samplePaths(name)) {
        expect(isIgnored(path), `${path} would be pruned from the VSIX`).toBe(false);
      }
    }
  });

  it('keeps the native addon path the bindings loader opens', () => {
    // better-sqlite3 ships prebuilds under bin/<platform>-<abi>/ and
    // rebuild:electron copies one into build/Release. `bindings` opens exactly
    // that path, so pruning the package but not the tree breaks openStore.
    expect(
      isIgnored('node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    ).toBe(false);
  });

  it('keeps the native binaries better-sqlite3 prebuild-installs', () => {
    // prebuild-install runs at install time, but the binaries it produced are
    // what `bindings` loads, so the .node payloads must survive the prune.
    for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
      expect(isIgnored(`node_modules/${name}/`), `${name} is pruned`).toBe(false);
    }
  });

  it('never re-includes a React path with a negation rule', () => {
    for (const rule of RULES.filter((line) => line.startsWith('!'))) {
      expect(/react|testing-library|eslint/i.test(rule), `${rule} re-includes a dev dependency`).toBe(
        false,
      );
    }
  });
});