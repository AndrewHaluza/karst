/**
 * The MCP tool surface derived from the CLI command registry.
 *
 * ONE tool per registry command (minus the verbs below that must never be an
 * agent tool), whose `inputSchema` IS the registry's JSON Schema — the registry
 * is the single source of truth `karst schema` already publishes. A call encodes
 * the validated object back to the argv the existing parser consumes
 * (`spec.toArgv`) and hands it to `runCli`/`runCliAsync`, so an MCP call and a
 * shell call run the SAME handler through the SAME parse path. No handler is
 * re-implemented here.
 */

import { COMMAND_SPECS, getCommandSpec, type CommandSpec } from '../registry.js';
import type { JsonSchema } from '../jsonSchema.js';
import type { McpServerConfig } from './config.js';

/**
 * Verbs that are in the registry but must NOT be exposed as MCP tools:
 *
 *  - `test` — the development-only driver can set stages and merge PRs. It is
 *    deliberately not an agent verb (see the guide); the CLI keeps it for
 *    scripts, the MCP surface drops it. This is the ONLY exclusion: every other
 *    registry command (including the host-invoked `graph`/`node`) becomes a tool,
 *    so the tool list is the registry minus `test`.
 */
export const MCP_EXCLUDED_COMMANDS: readonly string[] = ['test'];

/** One advertised MCP tool: the registry name/summary plus its input schema. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** A required string field from a schema-validated tool input. */
function requireToolString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`'${key}' must be a string`);
  return value;
}

/** Every command exposed as an MCP tool, in registry order. */
export function mcpTools(): McpTool[] {
  return COMMAND_SPECS.filter((spec) => !MCP_EXCLUDED_COMMANDS.includes(spec.name)).map((spec) => ({
    name: spec.name,
    description: spec.summary,
    inputSchema: spec.input,
  }));
}

/** The exposed tool names, for the "tool list matches the registry" check. */
export function mcpToolNames(): string[] {
  return mcpTools().map((tool) => tool.name);
}

/**
 * Encode a validated tool input as the argv the existing parser consumes,
 * INCLUDING the command name. Commands with a registry `toArgv` use it; the
 * verbs whose registry entry intentionally has no encoder — the flag-free
 * `guide`/`schema` and the closed-parser `graph`/`node` (which accept no
 * identity in argv, only the verb and its bounded `--reason`) — get a tiny
 * explicit encoding here.
 */
export function encodeToolArgv(
  spec: CommandSpec,
  input: Readonly<Record<string, unknown>>,
): string[] {
  if (spec.toArgv !== undefined) return spec.toArgv(input);
  if (spec.name === 'guide') return ['guide'];
  if (spec.name === 'schema') {
    const command = input.command;
    return typeof command === 'string' ? ['schema', command] : ['schema'];
  }
  if (spec.name === 'graph') return ['graph', requireToolString(input, 'verb')];
  if (spec.name === 'node') {
    const argv = ['node', requireToolString(input, 'verb')];
    if (input.reason !== undefined) argv.push('--reason', requireToolString(input, 'reason'));
    return argv;
  }
  throw new Error(`command '${spec.name}' cannot be invoked as an MCP tool`);
}

/**
 * The global `--db`/`--manifest`/`--ticket` tokens a command consumes, taken
 * from the server's resolved config. Only the flags the command DECLARES are
 * emitted (`draft` declares none, so it never sees a global it refuses).
 */
export function globalArgv(spec: CommandSpec, config: McpServerConfig): string[] {
  const globals = spec.globals ?? {};
  const argv: string[] = [];
  if (globals.db && config.db) argv.push('--db', config.db);
  if (globals.manifest && config.manifest) argv.push('--manifest', config.manifest);
  if (globals.ticket && config.ticket) argv.push('--ticket', config.ticket);
  return argv;
}

/** A command spec by tool name, or `undefined` when it is not exposed. */
export function exposedSpec(name: string): CommandSpec | undefined {
  if (MCP_EXCLUDED_COMMANDS.includes(name)) return undefined;
  return getCommandSpec(name);
}
