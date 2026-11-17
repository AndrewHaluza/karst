/**
 * Does the dependency plan of a repository fit? (@arch:GRAPHRUN)
 *
 * One read-only answer for two callers: the setup session proposes a
 * `graphWorkspace` block when the plan does not fit, and the graph start warns
 * (never blocks) when a repository with gate commands gets no dependencies.
 * The plan itself comes from `planWorkspaceDeps` in `depsPlan.ts`; nothing is
 * copied here. This module changes no file.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkNodeDeps } from '../../../workflow/gates/depsCheck.js';
import type { GraphWorkspaceDef } from '../../../manifest/types.js';
import { planWorkspaceDeps, resolvePlanPath } from './depsPlan.js';
import { editableHit, resolveChain } from './workspaceDeps.js';

/** Marker files of ecosystems whose dependencies live in user-level caches: a clone reaches them by itself. */
export const CACHE_ECOSYSTEM_MARKERS: readonly { ecosystem: string; test: (file: string) => boolean }[] = [
  { ecosystem: 'go', test: (f) => f === 'go.mod' },
  { ecosystem: 'rust', test: (f) => f === 'Cargo.toml' },
  { ecosystem: 'jvm', test: (f) => f === 'pom.xml' || /^build\.gradle(\.kts)?$/.test(f) },
  { ecosystem: 'ruby', test: (f) => f === 'Gemfile' },
];

export interface DepsAssessmentInput {
  repoName: string;
  /** The ticket worktree of the repository. */
  worktree: string;
  /** The main checkout the worktree resolves up to, when known. */
  mainCheckout?: string;
  /** The repository's explicit `graphWorkspace` block. */
  explicit?: GraphWorkspaceDef;
  /** Whether the repository declares gate commands. No gates → nothing is needed. */
  hasGates: boolean;
  /** Also scan link targets for links into another tree (slow on a large venv). */
  scanTraps?: boolean;
}

export type DepsAssessment =
  | { repoName: string; status: 'provided' | 'not-needed'; reason: string }
  | { repoName: string; status: 'gap'; reason: string };

const provided = (repoName: string, reason: string): DepsAssessment => ({ repoName, status: 'provided', reason });
const gap = (repoName: string, reason: string): DepsAssessment => ({ repoName, status: 'gap', reason });

function filesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function declaresDependencies(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const count = (value: unknown): number =>
      typeof value === 'object' && value !== null ? Object.keys(value).length : 0;
    return count(pkg.dependencies) + count(pkg.devDependencies) > 0;
  } catch {
    return false;
  }
}

/** The first root that holds the repo-relative path, or undefined. */
function linkRoot(relative: string, roots: readonly string[]): string | undefined {
  return roots.find((root) => existsSync(resolvePlanPath(root, relative)));
}

async function assessLinks(
  input: DepsAssessmentInput,
  link: readonly string[],
  setup: string | undefined,
  setupWhen: readonly string[],
  roots: readonly string[],
): Promise<string | undefined> {
  for (const relative of link) {
    const root = linkRoot(relative, roots);
    if (root === undefined) {
      if (setup === undefined) return `${relative} is missing in the worktree and graphWorkspace has no setup`;
      continue;
    }
    if (input.scanTraps === true) {
      const hit = await editableHit(resolvePlanPath(root, relative), roots);
      if (hit !== undefined) return `${relative} links into another tree (${hit})`;
    }
    const stale = setupWhen.find((file) => {
      try {
        return !readFileSync(resolvePlanPath(root, file)).equals(readFileSync(resolvePlanPath(input.worktree, file)));
      } catch {
        return false;
      }
    });
    if (stale !== undefined && setup === undefined) return `${stale} differs from the copy beside ${relative} and graphWorkspace has no setup`;
  }
  return undefined;
}

/** Assess one repository. Never throws: a failed read is a gap with its reason. */
export async function assessWorkspaceDeps(input: DepsAssessmentInput): Promise<DepsAssessment> {
  const { repoName } = input;
  if (!input.hasGates) return { repoName, status: 'not-needed', reason: 'no gate commands' };
  const roots = [input.worktree, ...(input.mainCheckout === undefined ? [] : [input.mainCheckout])];
  try {
    const plan = planWorkspaceDeps(input.worktree, input.explicit);
    if (plan.source === 'none') {
      const files = filesOf(input.worktree);
      const cache = CACHE_ECOSYSTEM_MARKERS.find((marker) => files.some(marker.test));
      return cache === undefined
        ? gap(repoName, 'no dependency default for this ecosystem — set graphWorkspace')
        : provided(repoName, `${cache.ecosystem} dependencies live in a user-level cache`);
    }
    if (plan.node) {
      const chain = resolveChain(input.worktree, input.mainCheckout);
      if (!chain.some((dir) => existsSync(join(dir, 'node_modules'))) && declaresDependencies(input.worktree)) {
        return gap(repoName, 'no node_modules resolves from the worktree — install it, or set graphWorkspace');
      }
      const check = await checkNodeDeps(input.worktree, {
        ...(input.mainCheckout === undefined ? {} : { repoRoot: input.mainCheckout }),
      });
      if (!check.ok) return gap(repoName, `node_modules does not match package-lock.json: ${check.reason}`);
    }
    const linkProblem = await assessLinks(input, plan.link, plan.setup, plan.setupWhen, roots);
    return linkProblem === undefined ? provided(repoName, plan.ecosystems.join(', ')) : gap(repoName, linkProblem);
  } catch (err) {
    return gap(repoName, `could not read the dependency state: ${String(err)}`);
  }
}

/** The one-line warning of a gap, e.g. `deps: web not provided`. */
export function depsWarningText(gaps: readonly DepsAssessment[]): string | undefined {
  const names = gaps.filter((a) => a.status === 'gap').map((a) => a.repoName);
  return names.length === 0 ? undefined : `deps: ${names.join(', ')} not provided`;
}
