/**
 * The `karst mcp serve` stdio server.
 *
 * Built on the low-level `@modelcontextprotocol/sdk` `Server` so the advertised
 * `inputSchema` IS the registry's JSON Schema, unchanged (`McpServer.registerTool`
 * would force a Zod re-encoding of every command and drift from the schema the
 * registry publishes). The tool list is the registry; a call is validated by the
 * SAME `validateCommandInput` the `--file`/`--stdin` path uses, encoded back to
 * argv, and dispatched to the SAME `runCli`/`runCliAsync` entrypoint — so the
 * MCP surface reuses every handler and every storage path (the CLI opens and
 * closes its store per invocation), and the `test` verb can never be reached.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { CliIo } from '../main.js';
import { validateCommandInput } from '../registry.js';
import type { McpServerConfig } from './config.js';
import { dispatchEnv } from './config.js';
import { encodeToolArgv, exposedSpec, globalArgv, mcpTools } from './tools.js';

/** How the server reaches the CLI handlers. Injected so unit tests need no store. */
export interface McpToolRunner {
  run(
    argv: string[],
    env: Readonly<Record<string, string | undefined>>,
    io: CliIo,
  ): Promise<string>;
}

export const KARST_MCP_SERVER_INFO = { name: 'karst', version: '1.0.0' } as const;

/** A caller error rendered as a tool error (never a server crash). */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Dispatch one tools/call. Validation happens against the registry schema BEFORE
 * encoding, so an off-shape input returns a clear tool error and no handler runs.
 */
export async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  config: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
  runner: McpToolRunner,
): Promise<CallToolResult> {
  const spec = exposedSpec(name);
  if (spec === undefined) return errorResult(`unknown or unavailable tool '${name}'`);

  let value: Readonly<Record<string, unknown>>;
  try {
    value = validateCommandInput(name, args);
  } catch (e) {
    return errorResult((e as Error).message);
  }

  let argv: string[];
  try {
    argv = [...encodeToolArgv(spec, value), ...globalArgv(spec, config)];
  } catch (e) {
    return errorResult((e as Error).message);
  }

  // `draft` and `setup propose-change` are the verbs whose input rides stdin,
  // not argv: the registry encoder names the verb and the validated object is
  // fed back as stdin. Every other verb ignores `readStdin` (no `--file`/
  // `--stdin` token is emitted).
  const io: CliIo =
    name === 'draft' || name === 'setup' ? { readStdin: () => JSON.stringify(value) } : { readStdin: () => '' };

  try {
    const text = await runner.run(argv, dispatchEnv(config, env), io);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return errorResult((e as Error).message);
  }
}

/**
 * A long-lived MCP server shares ONE `process.env` across every tool call, but a
 * handler may mutate it in place: `servers spin` scrubs every `KARST_*` key
 * (`serversCommand.ts` → `scrubKarstSessionEnv`) so a spawned service cannot
 * inherit the session's graph capability. That is correct for a short-lived CLI
 * and PERMANENT here — after the first `servers spin`, `graph`/`node` lose their
 * `KARST_GRAPH_*` launch env and guide-pull attribution (which reads
 * `process.env` live) silently stops recording. Snapshot the environment once at
 * server start and restore it after every call, so one call's mutations can
 * never leak into the next. Exported for the unit test.
 */
export function preservingProcessEnv(runner: McpToolRunner): McpToolRunner {
  const snapshot = new Map(Object.entries(process.env));
  return {
    async run(argv, env, io) {
      try {
        return await runner.run(argv, env, io);
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!snapshot.has(key)) delete process.env[key];
        }
        for (const [key, value] of snapshot) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  };
}

/** Register the tool list + call handlers on a fresh SDK server. */
export function createKarstMcpServer(
  config: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
  runner: McpToolRunner,
): Server {
  const server = new Server(KARST_MCP_SERVER_INFO, { capabilities: { tools: {} } });
  const guarded = preservingProcessEnv(runner);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, config, env, guarded),
  );
  return server;
}

/**
 * Serve over stdio until the client closes. Returns a promise that NEVER
 * resolves (the direct CLI wrapper must not print a result line onto the MCP
 * stdout stream); the process stays alive because the transport holds stdin.
 */
export async function runMcpServe(
  config: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
  runner: McpToolRunner,
  transport: StdioServerTransport = new StdioServerTransport(),
): Promise<string> {
  const server = createKarstMcpServer(config, env, runner);
  await server.connect(transport);
  return new Promise<string>(() => {
    // Intentionally never settles: `karst mcp serve` runs for the session's life.
  });
}
