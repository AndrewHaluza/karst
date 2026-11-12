import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The host-side reads of the base-moved check (D541): the gate state files and the base-check worktree parent.
 * Both mirror `scripts/gateState.mjs` and `scripts/vitestGate.mjs` (@arch:GATE-REPEAT), so the merged worktree
 * gets the same deps lookup as a gate run.
 */

const STATE_DIR = 'karst-gate-state';
const STATE_VERSION = 1;

/**
 * The merge base the newest CLEAN gate state saw, or null. `gitDir` is the git directory of the ticket worktree.
 * A state that is unreadable, not clean or without a base is ignored: not knowing means "no baseline".
 */
export async function readLastGreenBase(gitDir: string): Promise<string | null> {
  const dir = join(gitDir, STATE_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  let best: { base: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const state: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof state !== 'object' || state === null) continue;
      const s = state as { version?: unknown; clean?: unknown; base?: unknown };
      if (s.version !== STATE_VERSION || s.clean !== true || typeof s.base !== 'string' || s.base === '') continue;
      const mtime = (await stat(path)).mtimeMs;
      if (best === null || mtime > best.mtime) best = { base: s.base, mtime };
    } catch {
      continue;
    }
  }
  return best?.base ?? null;
}

/** The nearest ancestor of `cwd` whose node_modules holds vitest, or null (as `depsRoot` in `vitestGate.mjs`). */
export function findDepsRoot(cwd: string): string | null {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'vitest'))) return d;
    if (dirname(d) === d) return null;
  }
}

/** `<deps root>/.karst/base-check`, never under `.git`; the temp directory when no deps root exists. */
export function baseCheckParent(cwd: string, depsRoot: (cwd: string) => string | null = findDepsRoot): string {
  const root = depsRoot(cwd);
  if (root === null) return tmpdir();
  const parent = join(root, '.karst', 'base-check');
  mkdirSync(parent, { recursive: true });
  return parent;
}
