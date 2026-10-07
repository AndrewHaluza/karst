import { spawnSync } from 'node:child_process';
import type { AgentProvider } from '../manifest/types.js';
import { prepareCommand } from './command.js';
import {
  OPENCODE2_BINARY_SENTINEL,
  isSupportedOpencode2Version,
  opencode2BinaryPath,
  opencode2IsolationEnv,
  opencode2Config,
  parseOpencode2Version,
} from '../agent/opencode2Binary.js';

/**
 * Startup dependency preflight. karst shells out to
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
  /**
   * When present, the readiness command's OUTPUT is validated, not just its
   * exit code. opencode2 needs this: its binary is a required SETTING and the
   * SAME launcher name ships as v1, so a path that merely exits 0 is not proof
   * the right core is configured — `--version` must be range-checked. The
   * caller must inject an output probe (`readOutput`) or the dependency reads
   * not-ready rather than silently trusting an unreadable version.
   */
  readyOutput?: (stdout: string) => boolean;
  /**
   * The dependency is not usable WITHOUT probing anything — the setting that
   * names its binary is unset, or it is deliberately off. This exists for
   * opencode2: its unset sentinel is also the `@opencode/cli` PATH alias, so a
   * probe would find a real `opencode2` on PATH and wrongly read the core as
   * available. `unavailable` short-circuits BEFORE any PATH lookup.
   */
  unavailable?: string;
  /**
   * Environment every probe of this dependency must run under. opencode2 needs
   * it: its `--version` is itself a v2 process that would touch the user's real
   * XDG dirs, so even the existence/readiness probes must carry the karst-owned
   * dirs (criterion 2: isolation on EVERY spawn, not just agent runs).
   */
  probeEnv?: Readonly<Record<string, string>>;
}

/** A probe environment, layered over the host's `process.env` by the caller. */
export type ProbeEnv = Readonly<Record<string, string>>;

/** Returns true when the binary exists and can be executed. */
export type DependencyProbe = (binary: string, env?: ProbeEnv) => boolean;

/** Returns true when `<binary> <args>` exits 0. */
export type ReadinessProbe = (
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
) => boolean;

/** Captures `<binary> <args>` stdout + exit code, for `readyOutput`. */
export type OutputProbe = (
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
) => { stdout: string; exitCode: number };

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
 * The spawn `env` for a probe: the host env with the dependency's isolated
 * dirs layered on. Absent env → `undefined`, so the child inherits unchanged.
 */
function probeEnvOption(env?: ProbeEnv): { env: NodeJS.ProcessEnv } | Record<string, never> {
  return env ? { env: { ...process.env, ...env } } : {};
}

/**
 * Real probe: run `<binary> --version` and treat a clean exit as "present".
 * A missing binary surfaces as a spawn `error` (ENOENT); a present one exits 0.
 * Mirrors `preflight.ts`'s `gitOk` spawnSync usage. Never throws. `env` carries
 * a dependency's isolated dirs (opencode2) so the probe cannot touch the user's
 * real state.
 */
export function binaryExists(binary: string, env?: ProbeEnv): boolean {
  try {
    const p = prepareCommand(binary, ['--version']);
    const r = spawnSync(p.command, p.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: p.windowsVerbatimArguments,
      ...probeEnvOption(env),
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
export function commandSucceeds(
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
): boolean {
  try {
    const p = prepareCommand(binary, args);
    const r = spawnSync(p.command, p.args, {
      stdio: 'ignore',
      windowsVerbatimArguments: p.windowsVerbatimArguments,
      ...probeEnvOption(env),
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run `<binary> <args>` and return its captured stdout + exit code. Never
 * throws. This is the ONE capture probe; it exists for a caller that must read
 * the OUTPUT to judge readiness rather than the exit code alone — opencode2's
 * `--version` must be range-checked (`>=2.0.24 <3`), which an exit code cannot
 * express. Nothing sensitive is printed by `--version`; callers must not route
 * other tools' output through it. `env` carries the isolated dirs so the probe
 * process cannot touch the user's real state.
 */
export function readCommandOutput(
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
): { stdout: string; exitCode: number } {
  try {
    const p = prepareCommand(binary, args);
    const r = spawnSync(p.command, p.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: p.windowsVerbatimArguments,
      ...probeEnvOption(env),
    });
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      exitCode: r.error ? 1 : r.status ?? 1,
    };
  } catch {
    return { stdout: '', exitCode: 1 };
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
  readOutput?: OutputProbe,
): DependencyState {
  // A dependency with no configured binary is missing before any probe: a PATH
  // lookup could otherwise find an unrelated binary by the same name.
  if (dep.unavailable) return 'missing';
  if (!probe(dep.binary, dep.probeEnv)) return 'missing';
  // An output-validating dependency (opencode2's version range) must have its
  // readiness command's OUTPUT read; without the injected probe it reads
  // not-ready rather than trusting an exit code that a v1 binary also passes.
  if (dep.readyOutput) {
    if (!dep.ready || !readOutput) return 'not-ready';
    const { stdout, exitCode } = readOutput(dep.binary, dep.ready.args, dep.probeEnv);
    return exitCode === 0 && dep.readyOutput(stdout) ? 'ok' : 'not-ready';
  }
  if (!dep.ready) return 'ok';
  return ready(dep.binary, dep.ready.args, dep.probeEnv) ? 'ok' : 'not-ready';
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
  // opencode2 is the one provider whose binary is NOT resolved on PATH: v2
  // ships a launcher also named `opencode`, so a lookup would run v1. The
  // configured absolute path is required; unset is a normal "unavailable"
  // state whose message names the setting.
  if (provider === 'opencode2') {
    const configured = opencode2BinaryPath();
    const binary = configured || OPENCODE2_BINARY_SENTINEL;
    const install =
      "Set 'karst.opencode2.binaryPath' to the @opencode/cli v2 launcher " +
      '(https://www.npmjs.com/package/@opencode/cli), then reload the window.';
    return {
      binary,
      label: 'the OpenCode v2 CLI',
      install,
      enables: 'sessions',
      // UNSET must not become a PATH lookup: the sentinel is also the
      // `@opencode/cli` alias, so probing it would find a real `opencode2`.
      ...(configured
        ? {}
        : { unavailable: "karst.opencode2.binaryPath is not set" }),
      // Even the `--version` probes are v2 processes that would touch the
      // user's real dirs; every probe runs under the karst-owned XDG dirs.
      probeEnv: opencode2IsolationEnv(opencode2Config().home),
      // The SAME launcher name ships as v1, so a path that merely exits 0 is
      // not proof the right core is configured. Validate `--version` against
      // the accepted range, or the guard would launch v1 with v2 flags.
      ready: {
        args: ['--version'],
        fix:
          "Set 'karst.opencode2.binaryPath' to a @opencode/cli v2 binary " +
          '(>= 2.0.24 < 3) — a v1 binary cannot run the v2 flags.',
      },
      readyOutput: (stdout) => {
        const version = parseOpencode2Version(stdout);
        return version !== null && isSupportedOpencode2Version(version);
      },
    };
  }
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
  readOutput?: OutputProbe,
): DependencyFault[] {
  return registry
    .map((dep) => ({ dep, state: dependencyState(dep, probe, ready, readOutput) }))
    .filter((f): f is DependencyFault => f.state !== 'ok');
}

/**
 * Point-of-use guard: the tools this capability needs and cannot currently use.
 *
 * Startup preflight warns; this refuses. A capability check belongs at the entry
 * point that is about to use it, because the startup toast is minutes old by the
 * time the user clicks Ship, and because failing before the work starts is what
 * separates an actionable message from a stage-six fault banner.
 */
export function ensureCapability(
  capability: Capability,
  registry: readonly RequiredDependency[],
  probe: DependencyProbe,
  ready: ReadinessProbe,
  readOutput?: OutputProbe,
): DependencyFault[] {
  return checkDependencyFaults(requiredFor(capability, registry), probe, ready, readOutput);
}

/**
 * The one place install copy is composed. Leads with what the user loses, because
 * that is what they noticed; the tool name and the fix follow. Every surface shows
 * this same sentence, so github.ts no longer needs its own duplicate of it.
 */
export function renderMissingDependency(dep: RequiredDependency): string {
  const what = dep.unavailable ? 'is not configured' : "isn't installed";
  return `Karst can't ${CAPABILITY_PHRASE[dep.enables]}: ${dep.label} ${what}. ${dep.install}`;
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
  const fix = dep.ready?.fix ?? '';
  // An output-validating dependency (opencode2) is not "signed in" — it is the
  // wrong build. Name the real cause rather than the gh-auth sentence.
  if (dep.readyOutput) {
    return `Karst can't ${CAPABILITY_PHRASE[dep.enables]}: ${dep.label} is installed but not usable. ${fix}`;
  }
  return `Karst can't ${CAPABILITY_PHRASE[dep.enables]}: ${dep.label} is installed, but not signed in. ${fix}`;
}
