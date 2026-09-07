import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles, findAbsoluteHostPaths } from './agentsTree.js';

/**
 * Everything under `.agents/` ships to another machine — the graph package is
 * packed into the VSIX, the rpi skills are read by whatever agent the developer
 * runs. An absolute path from the machine that wrote the file is dead on every
 * other one: a different extension install dir, a different IDE-family
 * globalStorage (there are three karst.db instances across VS Code, Cursor and
 * Antigravity), a different checkout root, CI.
 *
 * This guard is the reason `.agents/skills/karst-rpi/SKILL.md` was removed from
 * git: it was `renderWorkflowCommand` output, materialized on one laptop and
 * committed with that laptop's paths baked into every command.
 *
 * The guard scans GIT-TRACKED files, not the on-disk tree: the generated skill
 * regenerates into the working tree on every launch while staying untracked, so
 * a disk-walking guard would go red on a clean checkout — exactly backwards.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('the .agents tree', () => {
  it('contains no absolute path from the machine that wrote it', () => {
    const offenders: string[] = [];
    for (const file of listTrackedFiles(REPO_ROOT, '.agents')) {
      // `git ls-files` lists INDEX entries: a file deleted from the working
      // tree but not yet staged as a delete is still listed here, and reading
      // it would throw ENOENT — an opaque failure unrelated to what this
      // guard checks. Skip files that aren't actually on disk.
      if (!existsSync(file)) {
        continue;
      }
      const hits = findAbsoluteHostPaths(readFileSync(file, 'utf8'));
      if (hits.length > 0) {
        offenders.push(`${relative(REPO_ROOT, file)}: ${hits.join(', ')}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
