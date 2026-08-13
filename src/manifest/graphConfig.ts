/**
 * The nested `graph:` block validator — one pure function, no fs, no vscode.
 *
 * `validateApproaches` (`schema.ts`) constructs a fresh object and therefore
 * DROPS unknown keys, which is why an unextended validator would destroy every
 * graph field a user wrote on the first load→save cycle. This module owns the
 * block: it defaults every absent field, rejects unknown keys, enforces the
 * closed vocabularies, and applies the product hard ceilings that project
 * configuration can never raise (invariant checklist A2–A4).
 *
 * The packaged defaults below ARE the design's Configuration Model defaults.
 * `builtIn.ts` consumes `DEFAULT_GRAPH_LIMITS` so the packaged definition and
 * the validator's empty-input defaults cannot drift apart; the packaged test
 * pins the literal values against the design.
 */

import { ManifestError } from './error.js';
import type {
  AgentProvider,
  GraphApproachConfig,
  GraphCommandConfig,
  GraphLimits,
  GraphPlannerConfig,
  GraphProfileConfig,
} from './types.js';

const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

const CWD_VALUES = ['repository', 'worktreeRoot'] as const;
const ACCESS_VALUES = ['read', 'write'] as const;

/** Product hard ceilings (design Budgets section). Configuration cannot raise these. */
export const GRAPH_HARD_CEILINGS: Readonly<Record<keyof Omit<GraphLimits, 'confirmGeneratedGraph'>, number>> = {
  maxParallel: 8,
  maxNodeRuns: 200,
  maxExpertRuns: 10,
  maxReplans: 5,
  maxActivations: 1000,
  maxGraphWallSeconds: 259200, // 72h
  maxAgentWallSeconds: 28800, // 8h
  maxAgentIdleSeconds: 7200, // 2h
  maxArtifactBytes: 104857600, // 100 MiB
  maxLogBytes: 10485760, // 10 MiB
  maxAggregateArtifactBytes: 1073741824, // 1 GiB
  maxAggregateWorkspaceBytes: 107374182400, // 100 GiB
};

/** Command timeout hard ceiling: 2h. Per-command `timeoutSeconds` is capped here. */
export const GRAPH_COMMAND_TIMEOUT_CEILING = 7200;

/** Packaged defaults (design Configuration Model + Budgets section). */
export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  confirmGeneratedGraph: true,
  // maxParallel 4 since Slice 5 (Task 7) — parallelism ships only after
  // workspaces, leases and lineage exist; the hard ceiling stays 8. A
  // project configuring 9 is still refused at manifest validation.
  maxParallel: 4,
  maxNodeRuns: 40,
  maxExpertRuns: 5,
  maxReplans: 2,
  maxActivations: 200,
  maxGraphWallSeconds: 86400,
  maxAgentWallSeconds: 7200,
  maxAgentIdleSeconds: 1800,
  maxArtifactBytes: 104857600,
  maxLogBytes: 10485760,
  maxAggregateArtifactBytes: 536870912,
  maxAggregateWorkspaceBytes: 21474836480, // 20 GiB
};

/** The hoisted pre-Decision-4 flat shape. Any of these beside `graph:` is refused. */
const HOISTED_KEYS = ['planner', 'profiles', 'commands', 'limits'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty string, bounded to a sane length so a hostile file cannot bloat memory. */
function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
    throw new ManifestError(`${where} must be a non-empty string of at most 512 characters`);
  }
  return v;
}

/**
 * A finite SAFE integer inside an explicit inclusive range. Fractions,
 * negatives, NaN, overflow, and strings are rejected — never coerced (a
 * coerced NaN would silently become a budget of 0 or ∞).
 */
function requireRangeInt(v: unknown, where: string, min: number, max: number): number {
  if (
    typeof v !== 'number'
    || !Number.isInteger(v)
    || !Number.isSafeInteger(v)
    || v < min
    || v > max
  ) {
    throw new ManifestError(`${where} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function requireBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new ManifestError(`${where} must be a boolean`);
  return v;
}

/** Reject unknown keys; the caller decides what the known set is. */
function assertKnownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!(known as readonly string[]).includes(key)) {
      throw new ManifestError(`${where} has unknown key "${key}"`);
    }
  }
}

/** Model id bound — mirrors the catalog's model grammar, so a config value is
 *  a value the CLI could actually receive. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;

function validateProfile(raw: unknown, where: string): GraphProfileConfig {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['provider', 'model', 'effort'], where);

  const provider = requireString(raw.provider, `${where}.provider`);
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ManifestError(
      `${where}.provider must be one of: ${AGENT_PROVIDERS.join(', ')}`,
    );
  }
  const model = requireString(raw.model, `${where}.model`);
  if (!MODEL_ID.test(model)) {
    throw new ManifestError(`${where}.model is not a valid model id`);
  }
  const profile: GraphProfileConfig = { provider: provider as AgentProvider, model };
  if (raw.effort !== undefined) {
    profile.effort = requireString(raw.effort, `${where}.effort`);
  }
  return profile;
}

/** A command's `env` is a bounded NAME: value map of strings. */
function validateEnv(raw: unknown, where: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(key)) {
      throw new ManifestError(`${where} has an invalid env key "${key}"`);
    }
    if (typeof value !== 'string' || value.length > 1024) {
      throw new ManifestError(`${where}.${key} must be a string of at most 1024 characters`);
    }
    env[key] = value;
  }
  return env;
}

function validateCommand(raw: unknown, where: string): GraphCommandConfig {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['command', 'args', 'cwd', 'access', 'timeoutSeconds', 'env'], where);

  const command = requireString(raw.command, `${where}.command`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(command)) {
    throw new ManifestError(`${where}.command is not a valid executable name`);
  }
  if (!Array.isArray(raw.args)) {
    throw new ManifestError(`${where}.args must be an array of strings`);
  }
  const args = raw.args.map((a, i) => requireString(a, `${where}.args[${i}]`));
  const cwd = requireString(raw.cwd, `${where}.cwd`);
  if (!(CWD_VALUES as readonly string[]).includes(cwd)) {
    throw new ManifestError(`${where}.cwd must be one of: ${CWD_VALUES.join(', ')}`);
  }
  const access = requireString(raw.access, `${where}.access`);
  if (!(ACCESS_VALUES as readonly string[]).includes(access)) {
    throw new ManifestError(`${where}.access must be one of: ${ACCESS_VALUES.join(', ')}`);
  }
  const timeoutSeconds = requireRangeInt(
    raw.timeoutSeconds,
    `${where}.timeoutSeconds`,
    1,
    GRAPH_COMMAND_TIMEOUT_CEILING, // command timeout <= 2h ceiling
  );
  const cmd: GraphCommandConfig = {
    command,
    args,
    cwd: cwd as GraphCommandConfig['cwd'],
    access: access as GraphCommandConfig['access'],
    timeoutSeconds,
  };
  const env = validateEnv(raw.env, `${where}.env`);
  if (env !== undefined) cmd.env = env;
  return cmd;
}

function validatePlanner(raw: unknown, where: string): GraphPlannerConfig {
  if (raw === undefined) return { profile: 'expert' }; // packaged default
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['profile', 'prompt'], where);
  const planner: GraphPlannerConfig = {
    profile: requireString(raw.profile, `${where}.profile`),
  };
  if (raw.prompt !== undefined) {
    if (!isObject(raw.prompt)) throw new ManifestError(`${where}.prompt must be a mapping`);
    assertKnownKeys(raw.prompt, ['artifact'], `${where}.prompt`);
    planner.prompt = {
      artifact: requireString(raw.prompt.artifact, `${where}.prompt.artifact`),
    };
  }
  return planner;
}

function validateLimits(raw: unknown, where: string): GraphLimits {
  if (raw === undefined) return { ...DEFAULT_GRAPH_LIMITS };
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(
    raw,
    Object.keys(DEFAULT_GRAPH_LIMITS) as readonly string[],
    where,
  );

  const limits = { ...DEFAULT_GRAPH_LIMITS };
  if (raw.confirmGeneratedGraph !== undefined) {
    limits.confirmGeneratedGraph = requireBoolean(
      raw.confirmGeneratedGraph,
      `${where}.confirmGeneratedGraph`,
    );
  }
  for (const field of Object.keys(GRAPH_HARD_CEILINGS) as (keyof typeof GRAPH_HARD_CEILINGS)[]) {
    if (raw[field] !== undefined) {
      limits[field] = requireRangeInt(
        raw[field],
        `${where}.${field}`,
        1,
        GRAPH_HARD_CEILINGS[field],
      );
    }
  }

  // Named manifest validation error, never a compile-time surprise (A4): a
  // graph that can never replan compiles and dies mid-run.
  if (limits.maxExpertRuns < limits.maxReplans + 1) {
    throw new ManifestError(
      `${where}.limits.maxExpertRuns must be at least maxReplans + 1 ` +
        `(got maxExpertRuns=${limits.maxExpertRuns}, maxReplans=${limits.maxReplans})`,
    );
  }
  return limits;
}

/**
 * Validate a raw `graph:` block into the typed `GraphApproachConfig`. Every
 * absent field is defaulted, every unknown key is rejected, and every numeric
 * value is a finite safe integer inside its explicit inclusive range.
 */
export function validateGraphConfig(raw: unknown, where: string): GraphApproachConfig {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['planner', 'profiles', 'commands', 'limits'], where);

  const config: GraphApproachConfig = {
    planner: validatePlanner(raw.planner, `${where}.planner`),
    profiles: {},
    commands: {},
    limits: validateLimits(raw.limits, `${where}.limits`),
  };

  if (raw.profiles !== undefined) {
    if (!isObject(raw.profiles)) throw new ManifestError(`${where}.profiles must be a mapping`);
    for (const [key, value] of Object.entries(raw.profiles)) {
      config.profiles[key] = validateProfile(value, `${where}.profiles.${key}`);
    }
  }

  if (raw.commands !== undefined) {
    if (!isObject(raw.commands)) throw new ManifestError(`${where}.commands must be a mapping`);
    for (const [key, value] of Object.entries(raw.commands)) {
      config.commands[key] = validateCommand(value, `${where}.commands.${key}`);
    }
  }

  return config;
}

/**
 * The both-shapes refusal, applied per approach entry BEFORE the block is
 * parsed: a file carrying both an old flat shape (hoisted `planner`/`profiles`/
 * `commands`/`limits`) and the nested `graph:` key is refused, never guessed —
 * mirroring the manifest's existing `services:`/`repositories:` both-keys
 * refusal.
 */
export function assertNoHoistedGraphKeys(raw: Record<string, unknown>, where: string): void {
  if (raw.graph === undefined) return;
  for (const key of HOISTED_KEYS) {
    if (raw[key] !== undefined) {
      throw new ManifestError(
        `${where} carries both the nested "graph:" block and the hoisted "${key}" key — ` +
          `remove one; the flat shape was retired (graph configuration lives under graph:)`,
      );
    }
  }
}
