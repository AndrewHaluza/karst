/**
 * The CLI command registry.
 *
 * Every agent-facing `karst` verb has exactly one entry here: a JSON Schema for
 * its input, the global flags it consumes, whether it writes, and (for the
 * commands that accept structured input) a `toArgv` encoder that turns a
 * validated JSON object into the argv tokens the module's existing parser
 * already understands. The handlers are NOT rewritten — this registry is a
 * declarative layer in front of the split parser modules, and `main.ts` keeps
 * its dispatch.
 *
 * Two consumers:
 *  - `karst schema [cmd]` prints these schemas so an agent (or #54's MCP layer)
 *    can discover a command's shape without reading source.
 *  - `main.ts` validates a `--file`/`--stdin` JSON object against the schema
 *    (via `validateJson`) before `toArgv` hands the argv to the existing
 *    parser, so a malformed payload fails with one clear, non-zero-exit error.
 */

import { validateJson, type JsonSchema } from './jsonSchema.js';

export interface CommandGlobals {
  /** Requires `--db <path>`. */
  readonly db?: boolean;
  /** Reads `--manifest <path>`. */
  readonly manifest?: boolean;
  /** Requires `--ticket <key>`. */
  readonly ticket?: boolean;
}

export interface CommandSpec {
  /** The verb as typed: the first token after the global flags. */
  readonly name: string;
  /** One-line description shown by `karst schema`. */
  readonly summary: string;
  /** JSON Schema for the command's structured input object. */
  readonly input: JsonSchema;
  /** Global flags the command consumes (informational; parsed in main.ts). */
  readonly globals?: CommandGlobals;
  /** True when the command mutates the store or the workspace. */
  readonly writes?: boolean;
  /**
   * Encode a schema-valid input object as the argv tokens (INCLUDING the
   * command name) that the existing parser consumes. Present only for commands
   * that accept `--file`/`--stdin` structured input.
   */
  readonly toArgv?: (input: Readonly<Record<string, unknown>>) => string[];
}

const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const strArray: JsonSchema = { type: 'array', items: str };
/**
 * An array the CLI parser receives as ONE comma-separated value. JSON elements
 * therefore may not contain a comma: `["a,b"]` would round-trip as two values.
 */
const csvArray: JsonSchema = { type: 'array', items: { type: 'string', pattern: '^[^,]*$' } };
/** Host proposal ids a draft waits on; `draft propose` takes them in its JSON. */
const proposalIdArray: JsonSchema = { type: 'array', items: { type: 'integer', minimum: 1 } };

function obj(
  properties: Readonly<Record<string, JsonSchema>>,
  required?: readonly string[],
): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

/** Push `--flag value` (or a bare `--flag` for `true`, a CSV for arrays). */
function pushFlag(argv: string[], flag: string, value: unknown): void {
  if (value === undefined || value === false || value === null) return;
  if (value === true) {
    argv.push(flag);
    return;
  }
  if (Array.isArray(value)) {
    // An empty list is the same as omitting the flag — the flag parser refuses
    // an empty CSV (`--repos ''`), so never emit one.
    if (value.length === 0) return;
    const items = value.map((v) => String(v));
    // Defense in depth: the schema `pattern` already rejects a comma inside a
    // CSV element, but a future array field that forgot it must not silently
    // split one element into two down the parser.
    const bad = items.find((v) => v.includes(','));
    if (bad !== undefined) throw new Error(`${flag} value '${bad}' cannot contain a comma`);
    argv.push(flag, items.join(','));
    return;
  }
  argv.push(flag, String(value));
}

function requireString(input: Readonly<Record<string, unknown>>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string') throw new Error(`'${key}' must be a string`);
  return v;
}

/**
 * Every CLI verb, in the order the unknown-command message lists them.
 * `schema` itself is included so `karst schema schema` works.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: 'context',
    summary: 'Read a ticket\'s live state (prompt, branches, PRs, gates).',
    input: obj({ key: str, format: { type: 'string', enum: ['json', 'md'] } }, ['key']),
    globals: { db: true, manifest: true },
    toArgv: (input) => {
      const argv = ['context', requireString(input, 'key')];
      pushFlag(argv, '--md', input.format === 'md');
      pushFlag(argv, '--json', input.format === 'json');
      return argv;
    },
  },
  {
    name: 'stats',
    summary: 'Read orchestration-effectiveness metrics for a project.',
    input: obj({ project: str, since: str, json: bool }),
    globals: { db: true, manifest: true },
    toArgv: (input) => {
      const argv = ['stats'];
      pushFlag(argv, '--project', input.project);
      pushFlag(argv, '--since', input.since);
      pushFlag(argv, '--json', input.json);
      return argv;
    },
  },
  {
    name: 'stage',
    summary: 'Fire the done marker for impl or fix (the only agent transition).',
    input: obj({ stage: { type: 'string', enum: ['impl', 'fix'] } }, ['stage']),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => ['stage', requireString(input, 'stage'), 'pass'],
  },
  {
    name: 'phase',
    summary: 'Append-only evidence that a workflow phase was entered.',
    input: obj({ name: str }, ['name']),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => ['phase', requireString(input, 'name')],
  },
  {
    name: 'graph',
    summary: 'Internal: submit the planner graph artifact (host-invoked only).',
    input: obj({ verb: { type: 'string', enum: ['submit'] } }, ['verb']),
    globals: { db: true },
    writes: true,
  },
  {
    name: 'node',
    summary: 'Internal: report a graph node outcome (host-invoked only).',
    input: obj(
      { verb: { type: 'string', enum: ['complete', 'block', 'replan'] }, reason: str },
      ['verb'],
    ),
    globals: { db: true },
    writes: true,
  },
  {
    name: 'test',
    summary: 'The development-only agent test driver.',
    input: obj({ subcommand: str }, ['subcommand']),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
  },
  {
    name: 'guide',
    summary: 'Print the agent manual (static, no DB).',
    input: obj({}),
  },
  {
    name: 'compact',
    summary: 'Compact archived worktrees and prune orphan branches.',
    input: obj({ olderThanDays: { type: 'integer', minimum: 0 } }),
    globals: { db: true },
    writes: true,
    toArgv: (input) => {
      const argv = ['compact'];
      pushFlag(argv, '--older-than-days', input.olderThanDays);
      return argv;
    },
  },
  {
    name: 'servers',
    summary: 'List, spin, restart or stop this ticket\'s services.',
    input: obj(
      { action: { type: 'string', enum: ['list', 'spin', 'restart', 'stop'] }, repos: csvArray },
      ['action'],
    ),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => {
      const argv = ['servers', requireString(input, 'action')];
      pushFlag(argv, '--repos', input.repos);
      return argv;
    },
  },
  {
    name: 'env',
    summary: 'Read or write per-ticket service environment overrides.',
    input: obj(
      {
        action: { type: 'string', enum: ['list', 'set', 'unset'] },
        service: str,
        values: bool,
        set: { type: 'object', additionalProperties: str },
        unset: strArray,
      },
      ['action'],
    ),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => {
      const argv = ['env', requireString(input, 'action')];
      pushFlag(argv, '--service', input.service);
      pushFlag(argv, '--values', input.values);
      if (input.set !== undefined) {
        for (const [key, value] of Object.entries(input.set as Record<string, string>)) {
          // The parser splits `KEY=VALUE` at the FIRST `=`, so a key that
          // contains one would be silently rewritten — reject it instead.
          if (key.includes('=')) throw new Error(`env set key '${key}' cannot contain '='`);
          argv.push(`${key}=${value}`);
        }
      }
      if (input.unset !== undefined) {
        for (const key of input.unset as string[]) {
          if (key.includes('=')) throw new Error(`env unset key '${key}' cannot contain '='`);
          argv.push(key);
        }
      }
      return argv;
    },
  },
  {
    name: 'subtask',
    summary: 'Carve a new sub-task out of the session\'s own ticket.',
    input: obj(
      {
        title: str,
        description: str,
        blocking: bool,
        repos: csvArray,
        start: bool,
      },
      ['title'],
    ),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => {
      const argv = ['subtask', 'create', '--title', requireString(input, 'title')];
      pushFlag(argv, '--description', input.description);
      pushFlag(argv, '--blocking', input.blocking);
      pushFlag(argv, '--repos', input.repos);
      // `start: false` is the CLI's `--no-start`; anything else leaves the default.
      if (input.start === false) argv.push('--no-start');
      return argv;
    },
  },
  {
    name: 'draft',
    summary: 'Planning-only: file a draft proposal (stdin JSON) or list drafts.',
    input: obj(
      {
        title: str,
        description: str,
        summary: str,
        repos: csvArray,
        id: { type: 'integer', minimum: 1 },
        dependsOn: proposalIdArray,
      },
      ['title', 'description', 'summary', 'repos'],
    ),
    writes: true,
    // `draft propose` consumes the object on stdin, so the encoder only names
    // the verb; the caller feeds the validated object back as stdin.
    toArgv: () => ['draft', 'propose'],
  },
  {
    name: 'message',
    summary: 'Send an async note to your direct parent or a direct child.',
    input: obj({ to: str, body: str }, ['to', 'body']),
    globals: { db: true, manifest: true, ticket: true },
    writes: true,
    toArgv: (input) => [
      'message',
      'send',
      '--to',
      requireString(input, 'to'),
      '--body',
      requireString(input, 'body'),
    ],
  },
  {
    name: 'inbox',
    summary: 'Read and mark-read your unread mailbox messages.',
    input: obj({ all: bool, json: bool }),
    globals: { db: true, manifest: true, ticket: true },
    toArgv: (input) => {
      const argv = ['inbox'];
      pushFlag(argv, '--all', input.all);
      pushFlag(argv, '--json', input.json);
      return argv;
    },
  },
  {
    name: 'fix-brief',
    summary: 'Read a summary of the failing gate a fix session must address.',
    input: obj({ key: str }, ['key']),
    globals: { db: true },
    toArgv: (input) => ['fix-brief', requireString(input, 'key')],
  },
  {
    name: 'conflict-brief',
    summary: 'Read a summary of a PR merge conflict a session must resolve.',
    input: obj({ key: str, repo: str }, ['key', 'repo']),
    globals: { db: true },
    toArgv: (input) => ['conflict-brief', requireString(input, 'key'), requireString(input, 'repo')],
  },
  {
    name: 'schema',
    summary: 'Print the input schema for every command, or one named command.',
    input: obj({ command: str }),
    toArgv: (input) => {
      const argv = ['schema'];
      if (input.command !== undefined) argv.push(requireString(input, 'command'));
      return argv;
    },
  },
];

const BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
  COMMAND_SPECS.map((spec) => [spec.name, spec]),
);

/** The spec for a verb, or `undefined` when it is not registered. */
export function getCommandSpec(name: string | undefined): CommandSpec | undefined {
  return name === undefined ? undefined : BY_NAME.get(name);
}

/** Every registered verb name, in registry order. */
export function commandNames(): string[] {
  return COMMAND_SPECS.map((spec) => spec.name);
}

/**
 * Validate a structured input object against a command's schema. Throws a
 * `<cmd>: <path>` error naming the offending field; returns the same object on
 * success so callers can chain. The message deliberately does NOT repeat the
 * `karst:` prefix the CLI wrapper adds, so stderr carries it exactly once.
 */
export function validateCommandInput(
  name: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const spec = getCommandSpec(name);
  if (spec === undefined) throw new Error(`unknown command '${name}'`);
  const err = validateJson(spec.input, value);
  if (err !== null) throw new Error(`${name}: invalid input — ${err}`);
  return value as Readonly<Record<string, unknown>>;
}
