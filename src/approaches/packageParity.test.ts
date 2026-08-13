import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { builtInPackageDir } from './builtIn.js';

/**
 * VSIX parity: the packaged built-in approach must ship in the extension with
 * the same bytes reviewers see in Git. A shipped package that is gitignored or
 * untracked is unreviewable — `.karst-plugin/` is gitignored today while its
 * files are tracked, so an "unignored" criterion would fail on the current
 * tree; TRACKED is the only criterion that means "reviewers can see it".
 *
 * Also pins the `karst-two-phase` retirement: no tracked path may match it.
 */
const repoRoot = join(import.meta.dirname, '..', '..');
const packageRoot = builtInPackageDir(repoRoot);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function trackedPaths(): string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

describe('built-in package VSIX parity', () => {
  const files = walk(packageRoot);
  const tracked = new Set(trackedPaths());

  it('the package root exists and contains files', () => {
    expect(existsSync(packageRoot)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('every file under the package root is tracked in Git', () => {
    const untracked = files
      .map((f) => relative(repoRoot, f))
      .filter((rel) => !tracked.has(rel));
    expect(untracked, 'files present on disk but not tracked in git').toEqual([]);
  });

  it('ships the entry descriptor and both prompt files', () => {
    expect(existsSync(join(packageRoot, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(packageRoot, 'skills', 'graph-planner', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(packageRoot, 'skills', 'graph-node', 'SKILL.md'))).toBe(true);
  });

  it('the planner prompt does not grant gate capabilities that do not exist', () => {
    const body = readFileSync(
      join(packageRoot, 'skills', 'graph-planner', 'SKILL.md'),
      'utf8',
    );
    // Gate predicates see visit counts, outcome counts, expert-run counts and
    // artifact existence ONLY — never exit codes, failing repository, or
    // artifact content. A prompt that PROMISED those would be authored against
    // a capability the compiler does not implement; naming them is allowed
    // only to deny them.
    for (const token of ['node-visits', 'node-outcomes', 'expert-runs', 'artifact-exists']) {
      expect(body).toMatch(token);
    }
    const lines = body.split('\n');
    for (const token of ['exit code', 'which repository failed', 'artifact content']) {
      const granting = lines.filter(
        (l) => l.toLowerCase().includes(token) && !/\b(never|not|cannot|no)\b/i.test(l),
      );
      expect(
        granting,
        `lines that grant "gates see ${token}" — a capability gates do not have`,
      ).toEqual([]);
    }
  });

  it('no tracked path matches the retired karst-two-phase package', () => {
    const offenders = [...tracked].filter((p) => p.includes('karst-two-phase'));
    expect(offenders, 'karst-two-phase must be fully retired from the tree').toEqual([]);
    expect(offenders).toEqual([]);
  });
});
