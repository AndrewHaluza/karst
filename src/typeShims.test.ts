import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function ambientModules(source: string): string[] {
  const results: string[] = [];
  const re = /declare\s+module\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    results.push(name);
  }
  return results;
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

function typesPackageFor(name: string): string {
  return name.startsWith('@')
    ? `@types/${name.slice(1).replace('/', '__')}`
    : `@types/${name}`;
}

interface Finding {
  file: string;
  module: string;
}

function findShadows(): Finding[] {
  const findings: Finding[] = [];
  for (const abs of walk(SRC_ROOT)) {
    if (!abs.endsWith('.d.ts')) continue;
    const source = readFileSync(abs, 'utf8');
    for (const mod of ambientModules(source)) {
      if (mod.startsWith('.') || mod.startsWith('/')) continue;
      if (declared.has(mod) || declared.has(typesPackageFor(mod))) {
        findings.push({ file: relative(REPO_ROOT, abs), module: mod });
      }
    }
  }
  return findings;
}

describe('ambient type shims', () => {
  it('no .d.ts under src/ shadows a declared dependency', () => {
    const findings = findShadows();
    expect(
      findings.map((f) => `${f.file}: declare module '${f.module}'`),
    ).toEqual([]);
  });

  it('finds ambient module declarations when they exist', () => {
    const result = ambientModules(
      "declare module 'jsdom' {}\ndeclare module './local.js' {}",
    );
    expect(result).toEqual(['jsdom', './local.js']);
  });
});
