import { spawnSync } from 'node:child_process';
import type { AgentProvider } from '../manifest/types.js';

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

/**
 * Per-provider agent-CLI dependency entries. Decoupled from agent/registry.ts:
 * a provider can be dependency-checked and given install guidance before it has
 * a working adapter. Only providers with confirmed install docs get a real
 * entry; others resolve through the generic fallback in `agentDependency`.
 */
export const AGENT_CLI_DEPENDENCIES: Partial<Record<AgentProvider, RequiredDependency>> = {
  claude: {
    binary: 'claude',
    label: 'the Claude Code CLI',
    install:
      "Install Claude Code (https://docs.claude.com/claude-code) so the 'claude' command is on your PATH, then reload the window.",
  },
};

/**
 * Resolve the dependency entry for an agent provider: the confirmed mapping, or
 * a generic honest fallback (binary = provider name) until real docs are added.
 */
export function agentDependency(provider: AgentProvider): RequiredDependency {
  return (
    AGENT_CLI_DEPENDENCIES[provider] ?? {
      binary: provider,
      label: `the ${provider} CLI`,
      install: `Install the ${provider} CLI and ensure '${provider}' is on your PATH, then reload the window.`,
    }
  );
}
