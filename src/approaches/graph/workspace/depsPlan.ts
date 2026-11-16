/**
 * The dependency plan of a graph node workspace (@arch:GRAPHRUN).
 *
 * A node workspace is a git clone under globalStorage. It has none of the
 * untracked dependency folders that its ticket worktree resolves, so the
 * repository's gate commands fail in a graph node. The plan says what the clone
 * receives, per ecosystem. This module is pure: it reads the file system only to
 * detect the ecosystem, and it changes nothing. `workspaceDeps.ts` applies it.
 *
 * `DEPS_DEFAULTS` is the ONE table of defaults. An explicit `graphWorkspace`
 * block of the manifest REPLACES the table row (it never merges with it), and
 * there is NO fallback to `sandbox.setup` (@arch:AC-36): that command is written
 * for the sandbox network window, not for the host.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphWorkspaceDef } from '../../../manifest/types.js';

/** What a clone receives. `node` means the merged `node_modules` of the resolve-up chain. */
export interface DepsPlan {
  /** Where the plan comes from: the manifest, or the detected ecosystem rows. */
  source: 'manifest' | 'detected' | 'none';
  /** The ecosystem rows that matched, for the debug line. */
  ecosystems: string[];
  node: boolean;
  /** Repo-relative paths linked from the worktree (or the main checkout). */
  link: string[];
  /** The host command run in the clone when a link is missing, unsafe or stale. */
  setup?: string;
  /** Repo-relative files whose clone copy must equal the copy beside the link target. */
  setupWhen: string[];
}

/** One row of the defaults table. */
export interface DepsDefaultRow {
  ecosystem: string;
  /** Whether the row applies to the worktree. */
  detect: (worktree: string, files: readonly string[]) => boolean;
  node?: boolean;
  link?: string[];
  setup?: string;
  setupWhen?: string[];
}

const has = (files: readonly string[], name: string): boolean => files.includes(name);

/**
 * The defaults, in match order. Node is a merge (not one link), so it carries
 * `node: true`. Go, Rust, JVM and Ruby have no row: their dependencies live in
 * user-level caches that a clone reaches by itself.
 */
export const DEPS_DEFAULTS: readonly DepsDefaultRow[] = [
  { ecosystem: 'node', detect: (_w, f) => has(f, 'package.json'), node: true },
  {
    ecosystem: 'python-uv',
    detect: (_w, f) => has(f, 'uv.lock'),
    link: ['.venv'],
    setup: 'uv sync --frozen',
    setupWhen: ['uv.lock'],
  },
  {
    ecosystem: 'python-poetry',
    detect: (_w, f) => has(f, 'poetry.lock') && !has(f, 'uv.lock'),
    link: ['.venv'],
    setup: 'poetry install --no-interaction',
    setupWhen: ['poetry.lock'],
  },
  {
    ecosystem: 'python-requirements',
    detect: (_w, f) =>
      !has(f, 'uv.lock') && !has(f, 'poetry.lock') && f.some((n) => /^requirements.*\.txt$/.test(n)),
    link: ['.venv'],
  },
];

function filesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build the plan for one repository worktree. */
export function planWorkspaceDeps(worktree: string, explicit?: GraphWorkspaceDef): DepsPlan {
  if (explicit !== undefined) {
    return {
      source: 'manifest',
      ecosystems: ['graphWorkspace'],
      node: false,
      link: [...(explicit.link ?? [])],
      ...(explicit.setup === undefined ? {} : { setup: explicit.setup }),
      setupWhen: [...(explicit.setupWhen ?? [])],
    };
  }
  if (!existsSync(worktree)) return { source: 'none', ecosystems: [], node: false, link: [], setupWhen: [] };
  const files = filesOf(worktree);
  const rows = DEPS_DEFAULTS.filter((row) => row.detect(worktree, files));
  if (rows.length === 0) return { source: 'none', ecosystems: [], node: false, link: [], setupWhen: [] };
  const withSetup = rows.find((row) => row.setup !== undefined);
  return {
    source: 'detected',
    ecosystems: rows.map((row) => row.ecosystem),
    node: rows.some((row) => row.node === true),
    link: [...new Set(rows.flatMap((row) => row.link ?? []))],
    ...(withSetup?.setup === undefined ? {} : { setup: withSetup.setup }),
    setupWhen: [...new Set(rows.flatMap((row) => row.setupWhen ?? []))],
  };
}

/** The repo-relative paths a plan can create in the clone: they go to `.git/info/exclude`. */
export function planCreatedPaths(plan: DepsPlan): string[] {
  return [...(plan.node ? ['node_modules'] : []), ...plan.link];
}

/** Whether the plan does anything at all. */
export function planIsEmpty(plan: DepsPlan): boolean {
  return !plan.node && plan.link.length === 0 && plan.setup === undefined;
}

/** `join` re-export kept local so callers resolve a plan path against a root the same way. */
export function resolvePlanPath(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}
