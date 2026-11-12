import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/**
 * Carry the clean gate states of the ticket worktree into the merged worktree, with `base` set to the base tip the
 * merge holds, so a gate there plans its scope against the last green TREE (@arch:GATE-REPEAT). The delta is then every
 * path that differs from the tree a green run saw (the base delta and the branch delta), and unit and integration
 * relate to it instead of running in full. A state that is not clean or not readable is not carried: that gate runs full.
 */
export async function seedMergedState(fromGitDir: string, toGitDir: string, baseSha: string): Promise<number> {
  const from = join(fromGitDir, STATE_DIR);
  const to = join(toGitDir, STATE_DIR);
  let names: string[];
  try {
    names = (await readdir(from)).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  await mkdir(to, { recursive: true });
  let seeded = 0;
  for (const name of names) {
    try {
      const state: unknown = JSON.parse(await readFile(join(from, name), 'utf8'));
      if (typeof state !== 'object' || state === null) continue;
      const s = state as { version?: unknown; clean?: unknown };
      if (s.version !== STATE_VERSION || s.clean !== true) continue;
      await writeFile(join(to, name), JSON.stringify({ ...state, base: baseSha }));
      seeded += 1;
    } catch {
      continue;
    }
  }
  return seeded;
}

/** The nearest ancestor of `cwd` whose node_modules holds vitest, or null (as `depsRoot` in `vitestGate.mjs`). */
export async function findDepsRoot(cwd: string): Promise<string | null> {
  for (let d = cwd; ; d = dirname(d)) {
    if (await exists(join(d, 'node_modules', 'vitest'))) return d;
    if (dirname(d) === d) return null;
  }
}

/** `<deps root>/.karst/base-check`, never under `.git`; the temp directory when no deps root exists. */
export async function baseCheckParent(cwd: string, depsRoot: (cwd: string) => Promise<string | null> = findDepsRoot): Promise<string> {
  const root = await depsRoot(cwd);
  if (root === null) return tmpdir();
  const parent = join(root, '.karst', 'base-check');
  await mkdir(parent, { recursive: true });
  return parent;
}
