/**
 * The dependency preflight of a graph start (@arch:GRAPHRUN).
 *
 * Before the bootstrap planner launches, each repository in scope is assessed
 * with `assessWorkspaceDeps`. A repository that has gate commands but gets no
 * dependencies yields a warning. The warning never blocks the launch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../../../manifest/types.js';
import { canonicalRepoId } from '../../../runtime/repoId.js';
import { REVIEW_PROBE_SCRIPTS, UAT_GATES } from '../../../workflow/gates/scripts.js';
import { assessWorkspaceDeps, depsWarningText, type DepsAssessment } from './depsAssess.js';
import { mainCheckoutOf } from './workspaceDeps.js';

export interface DepsPreflightInput {
  manifest: Manifest | undefined;
  /** The repositories in scope: manifest name and ticket worktree path. */
  repos: readonly { repoName: string; worktree: string; gitCommonDir: string | null }[];
}

function packageScripts(worktree: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { scripts?: unknown };
    return typeof pkg.scripts === 'object' && pkg.scripts !== null ? Object.keys(pkg.scripts) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a repository has gate commands: declared UAT or review gates (the
 * repository entry replaces the global list), else a probe script in its
 * package.json — the same default the review lane probes.
 */
export function repoHasGates(manifest: Manifest | undefined, repoName: string, worktree: string): boolean {
  const wanted = canonicalRepoId(repoName);
  const own = (record: Record<string, { gates?: unknown[] }> | undefined): unknown[] | undefined =>
    Object.entries(record ?? {}).find(([name]) => canonicalRepoId(name) === wanted)?.[1].gates;
  const uat = own(manifest?.uat?.repositories) ?? manifest?.uat?.gates;
  const review = own(manifest?.review?.repositories) ?? manifest?.review?.gates;
  if ((uat?.length ?? 0) > 0 || (review?.length ?? 0) > 0) return true;
  const probes = new Set<string>([...REVIEW_PROBE_SCRIPTS, ...UAT_GATES.map((gate) => gate.script)]);
  return packageScripts(worktree).some((script) => probes.has(script));
}

/** Assess every repository in scope. */
export async function preflightWorkspaceDeps(input: DepsPreflightInput): Promise<DepsAssessment[]> {
  const out: DepsAssessment[] = [];
  for (const repo of input.repos) {
    const wanted = canonicalRepoId(repo.repoName);
    const explicit = Object.entries(input.manifest?.repositories ?? {}).find(
      ([name]) => canonicalRepoId(name) === wanted,
    )?.[1].graphWorkspace;
    const mainCheckout = mainCheckoutOf(repo.gitCommonDir);
    out.push(
      await assessWorkspaceDeps({
        repoName: repo.repoName,
        worktree: repo.worktree,
        ...(mainCheckout === undefined ? {} : { mainCheckout }),
        ...(explicit === undefined ? {} : { explicit }),
        hasGates: repoHasGates(input.manifest, repo.repoName, repo.worktree),
      }),
    );
  }
  return out;
}

/** The warning of a preflight, or undefined when every repository gets its dependencies. */
export function preflightWarning(assessments: readonly DepsAssessment[]): string | undefined {
  return depsWarningText(assessments);
}
