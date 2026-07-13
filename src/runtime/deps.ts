import { spawnSync } from 'node:child_process';

/**
 * Startup dependency preflight (§ todo-5 dependencies check). karst shells out to
 * external CLIs it does not bundle — git for worktrees, the agent CLI (Claude
 * Code by default) to run sessions. If one is missing the user hits a cryptic
 * ENOENT deep in a spin; this checks up front and points them at an install.
 *
 * `checkDependencies` is pure (probe injected) so it is unit-testable; the real
 * host passes `binaryExists`, which runs `<bin> --version` once.
 */

export interface RequiredDependency {
  /** The executable name looked up on PATH. */
  binary: string;
  /** Human name for the message, e.g. "Git". */
  label: string;
  /** Actionable guidance: what to install and where from. */
  install: string;
}

/** Returns true when the binary exists and can be executed. */
export type DependencyProbe = (binary: string) => boolean;

/** Git — always required (worktrees, baseline branch validation). */
export const GIT_DEPENDENCY: RequiredDependency = {
  binary: 'git',
  label: 'Git',
  install: 'Install Git from https://git-scm.com/downloads, then reload the window.',
};

/** The dependencies that probe as absent, in the given order. */
export function checkDependencies(
  required: readonly RequiredDependency[],
  probe: DependencyProbe,
): RequiredDependency[] {
  return required.filter((d) => !probe(d.binary));
}

/**
 * Real probe: run `<binary> --version` and treat a clean exit as "present".
 * A missing binary surfaces as a spawn `error` (ENOENT); a present one exits 0.
 * Mirrors `preflight.ts`'s `gitOk` spawnSync usage. Never throws.
 */
export function binaryExists(binary: string): boolean {
  try {
    const r = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
