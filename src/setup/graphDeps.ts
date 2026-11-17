/**
 * Do the D644 graph-workspace defaults fit a repository? (@arch:GRAPHRUN)
 *
 * The setup session reads this verdict from `setup discover` and proposes a
 * `graphWorkspace` block only for a `gap`. The plan comes from
 * `planWorkspaceDeps` (the D644 pure function); this module adds three
 * synchronous checks and changes no file.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { planWorkspaceDeps, resolvePlanPath } from '../approaches/graph/workspace/depsPlan.js';
import { CACHE_ECOSYSTEM_MARKERS } from '../approaches/graph/workspace/depsAssess.js';

/** Dependency folders that no default row links. A folder here means the defaults miss it. */
export const NON_DEFAULT_DEP_FOLDERS: readonly string[] = ['venv', 'env', 'vendor', '.bundle', 'bower_components'];

export type GraphDepsFit =
  | { status: 'fits'; reason: string }
  | { status: 'gap'; reason: string };

const fits = (reason: string): GraphDepsFit => ({ status: 'fits', reason });
const gap = (reason: string): GraphDepsFit => ({ status: 'gap', reason });

function filesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function insideTree(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A link target that is itself a symlink into the checkout would link a tree back to itself. */
function selfLink(repoPath: string, link: string): boolean {
  const path = resolvePlanPath(repoPath, link);
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return insideTree(realpathSync(repoPath), realpathSync(path));
  } catch {
    return false;
  }
}

/** Judge one repository checkout. Never throws. */
export function describeGraphDeps(repoPath: string): GraphDepsFit {
  try {
    const files = filesOf(repoPath);
    const plan = planWorkspaceDeps(repoPath);
    const other = NON_DEFAULT_DEP_FOLDERS.find(
      (dir) => existsSync(join(repoPath, dir)) && !plan.link.includes(dir),
    );
    if (other !== undefined) return gap(`${other}/ holds dependencies that no default links`);
    const self = plan.link.find((link) => selfLink(repoPath, link));
    if (self !== undefined) return gap(`${self} links into the checkout itself`);
    if (plan.source === 'none') {
      const cache = CACHE_ECOSYSTEM_MARKERS.find((marker) => files.some(marker.test));
      if (cache !== undefined) return fits(`${cache.ecosystem} dependencies live in a user-level cache`);
      return files.some((f) => /^(package\.json|pyproject\.toml|requirements.*\.txt|Makefile)$/.test(f))
        ? gap('gate commands may need dependencies and no default covers this ecosystem')
        : fits('no dependency manifest found');
    }
    return fits(plan.ecosystems.join(', '));
  } catch (err) {
    return gap(`could not read the dependency state: ${String(err)}`);
  }
}
