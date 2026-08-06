import { spawnSync } from 'node:child_process';
import type { AgentProvider } from '../manifest/types.js';
import { prepareCommand } from './command.js';

/**
 * Startup dependency preflight (§ todo-5 dependencies check). karst shells out to
 * external CLIs it does not bundle — git for worktrees, the agent CLI (Claude
 * Code by default) to run sessions. If one is missing the user hits a cryptic
 * ENOENT deep in a spin; this checks up front and points them at an install.
 *
 * `checkDependencies` is pure (probe injected) so it is unit-testable; the real
 * host passes `binaryExists`, which runs `<bin> --version` once.
 */

/**
 * What the user loses when a dependency is absent. Drives both the message and
 * the point-of-use guard, so a dependency cannot be declared without an answer
 * to "and what breaks if it's gone?".
 */
export type Capability = 'worktrees' | 'gates' | 'sessions' | 'ship';

/** Capability → the sentence fragment every message is built from. */
const CAPABILITY_PHRASE: Record<Capability, string> = {
  worktrees: 'create worktrees',
  gates: 'run the uat and review gates',
  sessions: 'run agent sessions',
  ship: 'open pull requests',
};

export interface RequiredDependency {
  /** The executable name looked up on PATH. */
  binary: string;
  /** Human name for the message, e.g. "Git". */
  label: string;
  /** Actionable guidance: what to install and where from. */
  install: string;
  /** The capability this dependency unlocks. */
  enables: Capability;
  /**
   * Installed is not always usable: gh present but logged out fails ship exactly
   * like gh absent. `args` is a command that exits 0 only when the tool is ready;
   * `fix` is what the user does about it. Omit for tools where being on PATH is
   * the whole story — there is nothing to be logged in to for git or npm.
   */
  ready?: { args: readonly string[]; fix: string };
}

/** Returns true when the binary exists and can be executed. */
export type DependencyProbe = (binary: string) => boolean;

/** Returns true when `<binary> <args>` exits 0. */
export type ReadinessProbe = (binary: string, args: readonly string[]) => boolean;

/** How usable a dependency is right now. */
export type DependencyState = 'ok' | 'missing' | 'not-ready';

/** Git — always required (worktrees, baseline branch validation). */
export const GIT_DEPENDENCY: RequiredDependency = {
  binary: 'git',
  label: 'Git',
  install: 'Install Git from https://git-scm.com/downloads, then reload the window.',
  enables: 'worktrees',
};

/**
 * npm — runs the worktree dependency install and both gates (uat, review). Never
 * checked until now, which is the same latent failure gh had, only worse: a
 * missing npm makes every gate exit nonzero, which the driver reads as a code
 * verdict and parks the ticket in a fix loop no agent can win.
 */
export const NPM_DEPENDENCY: RequiredDependency = {
  binary: 'npm',
  label: 'npm',
  install:
    "Install Node.js (which bundles npm) from https://nodejs.org so the 'npm' command is on your PATH, then reload the window.",
  enables: 'gates',
};

/**
 * The GitHub CLI — required to ship (`gh pr create`). Checked at startup even
 * though only the last stage uses it: a missing gh otherwise stays invisible
 * until a ticket has been scoped, implemented, gated and reviewed, and then
 * fails at the one point where all that work was supposed to pay off.
 */
export const GH_DEPENDENCY: RequiredDependency = {
  binary: 'gh',
  label: 'the GitHub CLI',
  install:
    "Install the GitHub CLI from https://cli.github.com so the 'gh' command is on your PATH, run 'gh auth login', then reload the window.",
  enables: 'ship',
  // `gh auth token` exits 0 only when gh has a token stored for the host, and it
  // answers from local config — no network. `gh auth status` is the better-known
  // check but validates the token against the API, so it also fails when the user
  // is merely offline. This guard REFUSES to ship, and blocking an offline user
  // with "you're not signed in" would send them to re-run a login that works.
  // The tradeoff: a stored-but-revoked token reads as ready, and ship then fails
  // with gh's own error — the behaviour we already have, not a new hole.
  ready: { args: ['auth', 'token'], fix: "Run 'gh auth login' to sign in." },
};

/**
 * Real probe: run `<binary> --version` and treat a clean exit as "present".
 * A missing binary surfaces as a spawn `error` (ENOENT); a present one exits 0.
 * Mirrors `preflight.ts`'s `gitOk` spawnSync usage. Never throws.
 */
export function binaryExists(binary: string): boolean {
  try {
    const p = prepareCommand(binary, ['--version']);
    const r = spawnSync(p.command, p.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Real readiness probe: `<binary> <args>` exits 0. Never throws.
 *
 * Output is discarded rather than captured, because the exit code is the whole
 * answer and a readiness check may print a secret — `gh auth token` writes the
 * user's token to stdout. Nothing karst never reads can ever be logged.
 */
export function commandSucceeds(binary: string, args: readonly string[]): boolean {
  try {
    const p = prepareCommand(binary, args);
    const r = spawnSync(p.command, p.args, {
      stdio: 'ignore',
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * How usable a dependency is. Readiness is only asked of a tool that is actually
 * installed — `gh auth status` on a machine without gh answers nothing and costs
 * a spawn — and only of one that declares a readiness check.
 *
 * Both probes are required, with no live default: a default that shells out
 * lets a caller reach PATH by omission, which is how a pure unit test ends up
 * asking the real machine whether the real gh is logged in.
 */
export function dependencyState(
  dep: RequiredDependency,
  probe: DependencyProbe,
  ready: ReadinessProbe,
): DependencyState {
  if (!probe(dep.binary)) return 'missing';
  if (!dep.ready) return 'ok';
  return ready(dep.binary, dep.ready.args) ? 'ok' : 'not-ready';
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
    enables: 'sessions',
  },
  codex: {
    binary: 'codex',
    label: 'the OpenAI Codex CLI',
    install:
      "Install the Codex CLI from https://developers.openai.com/codex/cli so the 'codex' command is on your PATH, then reload the window.",
    enables: 'sessions',
  },
  antigravity: {
    binary: 'agy',
    label: 'the Antigravity CLI (agy)',
    install:
      'Install the Antigravity CLI and ensure "agy" is on your PATH.',
    enables: 'sessions',
  },
  opencode: {
    binary: 'opencode',
    label: 'the OpenCode CLI',
    install:
      "Install OpenCode from https://opencode.ai so the 'opencode' command is on your PATH, then reload the window.",
    enables: 'sessions',
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
      enables: 'sessions',
    }
  );
}

/**
 * THE list of external tools karst spawns itself, for a given agent provider.
 * Every surface — the startup preflight, the status bar, the welcome checklist,
 * the point-of-use guards — derives from this and hardcodes nothing. Adding a
 * dependency is one entry here.
 *
 * Not included: the arbitrary shell strings in the manifest's service commands.
 * `docker compose up` cannot be honestly preflighted; those fail at spin with the
 * supervisor's own error.
 */
export function dependencyRegistry(provider: AgentProvider): RequiredDependency[] {
  return [GIT_DEPENDENCY, NPM_DEPENDENCY, GH_DEPENDENCY, agentDependency(provider)];
}

/** The registry entries a capability depends on. */
export function requiredFor(
  capability: Capability,
  registry: readonly RequiredDependency[],
): RequiredDependency[] {
  return registry.filter((d) => d.enables === capability);
}

/** A dependency that is not usable, and how it isn't. */
export interface DependencyFault {
  dep: RequiredDependency;
  state: Exclude<DependencyState, 'ok'>;
}

/** Every tool in the registry that is not usable, in registry order. */
export function checkDependencyFaults(
  registry: readonly RequiredDependency[],
  probe: DependencyProbe,
  ready: ReadinessProbe,
): DependencyFault[] {
  return registry
    .map((dep) => ({ dep, state: dependencyState(dep, probe, ready) }))
    .filter((f): f is DependencyFault => f.state !== 'ok');
}

/**
 * Point-of-use guard: the tools this capability needs and cannot currently use.
 *
 * Startup preflight warns; this refuses. A capability check belongs at the entry
 * point that is about to use it, because the startup toast is minutes old by the
 * time the user clicks Ship, and because failing before the work starts is what
 * separates an actionable message from a fault card at stage six.
 */
export function ensureCapability(
  capability: Capability,
  registry: readonly RequiredDependency[],
  probe: DependencyProbe,
  ready: ReadinessProbe,
): DependencyFault[] {
  return checkDependencyFaults(requiredFor(capability, registry), probe, ready);
}

/**
 * The one place install copy is composed. Leads with what the user loses, because
 * that is what they noticed; the tool name and the fix follow. Every surface shows
 * this same sentence, so github.ts no longer needs its own duplicate of it.
 */
export function renderMissingDependency(dep: RequiredDependency): string {
  return `Karst can't ${CAPABILITY_PHRASE[dep.enables]}: ${dep.label} isn't installed. ${dep.install}`;
}

/**
 * What to tell the user about a dependency in a given state. Null when there is
 * nothing to say.
 *
 * A readiness probe is chosen so that its failure has ONE plausible cause (see
 * GH_DEPENDENCY.ready) — that is what earns this message the right to name the
 * cause instead of listing possibilities the user has to rule out themselves.
 */
export function renderDependencyFault(
  dep: RequiredDependency,
  state: DependencyState,
): string | null {
  if (state === 'ok') return null;
  if (state === 'missing') return renderMissingDependency(dep);
  return `Karst can't ${CAPABILITY_PHRASE[dep.enables]}: ${dep.label} is installed, but not signed in. ${dep.ready?.fix ?? ''}`;
}
