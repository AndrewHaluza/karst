/**
 * `karst schema [command]` — print the CLI's input schemas as JSON.
 *
 * This is the discovery surface for the command registry: an agent (or #54's
 * MCP layer) runs it to learn a command's exact input shape instead of reading
 * source, then supplies that input as named flags, `--file <path>`, or stdin
 * JSON. Printing one command's schema is the common case; a bare
 * `karst schema` prints them all.
 */

import { SETUP_EDIT_TOOL_NAMES, findEditTool } from './setupEdit/tools.js';
import { COMMAND_SPECS, commandNames, getCommandSpec, type CommandGlobals } from './registry.js';

interface RenderedCommand {
  readonly command: string;
  readonly summary: string;
  readonly globals: CommandGlobals;
  readonly writes: boolean;
  /** True when the verb accepts `--file`/`--stdin` structured input. */
  readonly structured: boolean;
  readonly input: unknown;
}

function render(specName: string): RenderedCommand {
  const spec = getCommandSpec(specName)!;
  return {
    command: spec.name,
    summary: spec.summary,
    globals: spec.globals ?? {},
    writes: spec.writes ?? false,
    structured: spec.toArgv !== undefined,
    input: spec.input,
  };
}

/**
 * Parse `['schema']` or `['schema', <command>]`. Rejects flags, trailing argv
 * and an unknown command — naming the verbs it does know.
 */
export function parseSchemaArgs(argv: string[]): string | undefined {
  const [cmd, target, ...rest] = argv;
  if (cmd !== 'schema') {
    throw new Error(`expected 'schema' command, got '${cmd ?? ''}'`);
  }
  if (target !== undefined && target.startsWith('-')) {
    throw new Error(`unknown flag '${target}' (usage: schema [command])`);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument '${rest[0]!}' (usage: schema [command])`);
  }
  if (target !== undefined && getCommandSpec(target) === undefined) {
    throw new Error(`unknown command '${target}' (want one of ${commandNames().join(', ')})`);
  }
  return target;
}

/** `karst schema setup <tool>`: the fields a typed setup tool takes (generated from the section schemas). */
function runSetupToolSchema(tool: string): string {
  const spec = findEditTool(tool);
  if (spec === undefined) {
    throw new Error(`unknown setup tool '${tool}' (want one of ${SETUP_EDIT_TOOL_NAMES.join(', ')})`);
  }
  return JSON.stringify({ command: `setup ${spec.name}`, summary: spec.summary, input: spec.inputSchema }, null, 2);
}

/** Validate argv and return the schema JSON (one command, or all). */
export function runSchemaCommand(argv: string[]): string {
  if (argv[1] === 'setup' && argv.length === 3) return runSetupToolSchema(argv[2]!);
  const target = parseSchemaArgs(argv);
  if (target !== undefined) return JSON.stringify(render(target), null, 2);
  return JSON.stringify({ commands: COMMAND_SPECS.map((s) => render(s.name)) }, null, 2);
}
